-- LiveOps V1 schema.
-- Design notes live in docs/adr — this file is the source of truth for shape.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,      -- sha256 hex of the raw key; raw key is shown once at creation
  key_prefix  TEXT NOT NULL,             -- first 8 chars, for display/lookup in logs without revealing the key
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

-- ---------------------------------------------------------------------------
-- Event log — append-only. This is the system of record.
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  -- internal surrogate key; used for stable ordering (append order) since
  -- occurred_at is client-supplied and cannot be trusted for sequencing.
  seq             BIGSERIAL PRIMARY KEY,
  event_id        TEXT NOT NULL,          -- caller-supplied idempotency key
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  type            TEXT NOT NULL,          -- e.g. "order.created", versioned as "order.created.v1"
  correlation_id  TEXT NOT NULL,          -- ties together everything caused by one originating request
  causation_id    TEXT,                   -- the event/command that directly caused this one, if any
  payload         JSONB NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,   -- caller-asserted event time
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ingest idempotency: the same (tenant, event_id) can be POSTed any number
  -- of times and is recorded exactly once. See ADR-005.
  CONSTRAINT uq_events_tenant_event UNIQUE (tenant_id, event_id)
);

CREATE INDEX idx_events_tenant_seq ON events(tenant_id, seq);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_correlation ON events(correlation_id);

-- ---------------------------------------------------------------------------
-- Transactional outbox — written in the same transaction as `events`.
-- A separate poller is the only thing that reads and dispatches this table.
-- ---------------------------------------------------------------------------

CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  event_seq     BIGINT NOT NULL REFERENCES events(seq),
  topic         TEXT NOT NULL,            -- logical topic, e.g. "domain.events"
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | dispatched | failed
  attempts      INT NOT NULL DEFAULT 0,
  locked_by     TEXT,                     -- poller instance id holding the lease
  locked_until  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ
);

CREATE INDEX idx_outbox_pending ON outbox(status, locked_until) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Consumer offsets — per logical handler, so each handler group processes
-- the event log independently (mirrors a Kafka consumer group's committed
-- offset). This table is also what projection rebuild resets. See ADR-002.
-- ---------------------------------------------------------------------------

CREATE TABLE consumer_checkpoints (
  handler       TEXT PRIMARY KEY,
  last_seq      BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Workflow engine — durable state. The engine reconstructs everything it
-- needs from these two tables after a restart; nothing lives only in memory.
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  definition      TEXT NOT NULL,          -- e.g. "order-fulfillment"
  correlation_id  TEXT NOT NULL,
  trigger_event_seq BIGINT REFERENCES events(seq),
  status          TEXT NOT NULL DEFAULT 'running', -- running | completed | compensating | failed | compensated
  current_step    INT NOT NULL DEFAULT 0,
  context         JSONB NOT NULL DEFAULT '{}',      -- accumulated step outputs, read/written by steps
  error           TEXT,
  locked_by       TEXT,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_status ON workflow_executions(status);
CREATE INDEX idx_workflow_tenant ON workflow_executions(tenant_id);
-- Drives crash-resume: pick up executions whose lease has expired.
CREATE INDEX idx_workflow_resumable ON workflow_executions(status, locked_until)
  WHERE status IN ('running', 'compensating');

CREATE TABLE step_executions (
  id            BIGSERIAL PRIMARY KEY,
  execution_id  UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_index    INT NOT NULL,
  step_name     TEXT NOT NULL,
  direction     TEXT NOT NULL DEFAULT 'forward', -- forward | compensate
  status        TEXT NOT NULL DEFAULT 'running', -- running | succeeded | failed
  attempts      INT NOT NULL DEFAULT 0,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX idx_step_executions_execution ON step_executions(execution_id, step_index, direction);

-- ---------------------------------------------------------------------------
-- Dead letters — terminal home for anything that exhausted its retry budget.
-- Nothing is ever silently dropped; it lands here with full context.
-- ---------------------------------------------------------------------------

CREATE TABLE dead_letters (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,           -- 'outbox' | 'consumer:<handler>' | 'workflow:<definition>'
  event_seq     BIGINT REFERENCES events(seq),
  execution_id  UUID REFERENCES workflow_executions(id),
  attempts      INT NOT NULL,
  last_error    TEXT NOT NULL,
  context       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at   TIMESTAMPTZ
);

CREATE INDEX idx_dead_letters_open ON dead_letters(created_at) WHERE replayed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Read models (CQRS). Populated only by the projection worker, consuming
-- `events` via its own checkpoint. Query paths must never read the tables
-- above directly. See ADR (CQRS) in docs/adr.
-- ---------------------------------------------------------------------------

CREATE TABLE projection_throughput_minute (
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  minute        TIMESTAMPTZ NOT NULL,
  event_count   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, minute)
);

CREATE TABLE projection_workflow_summary (
  execution_id    UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  definition      TEXT NOT NULL,
  status          TEXT NOT NULL,
  current_step    INT NOT NULL,
  step_count      INT NOT NULL,
  correlation_id  TEXT NOT NULL,
  error           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_proj_workflow_tenant_status ON projection_workflow_summary(tenant_id, status);

CREATE TABLE projection_tenant_activity (
  tenant_id       UUID PRIMARY KEY REFERENCES tenants(id),
  event_count     BIGINT NOT NULL DEFAULT 0,
  last_event_at   TIMESTAMPTZ
);
