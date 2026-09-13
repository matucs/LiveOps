# LiveOps

**LiveOps is a production-inspired, event-driven platform demonstrating
distributed systems, workflow orchestration, CQRS, reliability
engineering, observability, and measurement-driven performance work.**

Built as a modular monolith first, deliberately. Every architectural
choice below was made against a real alternative, most were tested by
actually breaking the system, and one section (Phase 06) documents a
plausible fix that was implemented, measured, and found to do nothing —
kept in the record instead of edited out, because that's what
measurement-driven engineering actually looks like.

**Live: https://liveops.130-61-191-125.nip.io** — a real deployment
(Oracle Cloud free tier, Docker, Caddy, Let's Encrypt), not a screenshot.
Open it and click **"Send a new order"** in the chaos panel, then
**"Force shipment to always fail"** and send another, to watch a saga
complete and then compensate live. See `docs/deployment.md` for how it's
built and a real bug the deployment itself found and fixed.

## Status

V1 complete: ingest, transactional outbox, a Postgres-backed event bus,
a workflow engine with saga compensation, CQRS projections, a live
dashboard with a chaos panel, a load test that found and fixed two real
bottlenecks, a live public deployment, and this documentation.

Not built (V1 scope, by design — see "Deliberately not built" below):
Kafka, Redis, service extraction, an AI incident investigator, cloud
deployment. The [full build plan](https://claude.ai/code/artifact/cd104abd-e269-4ee2-a125-d6ca1b7ae08a),
including the V2 roadmap for these, was scoped before writing any code.

## Architecture

See [`docs/diagrams/`](docs/diagrams/) for the full set (source-controlled
Mermaid, kept in sync with the implementation, not the aspirational
target). Start with the container diagram:

```mermaid
flowchart TB
    Browser["Next.js dashboard<br/>(apps/web)"] -- "REST + SSE" --> HTTP
    Caller["curl / external caller"] -- "REST" --> HTTP
    subgraph API["apps/api — one Node process"]
        HTTP["Fastify HTTP layer"]
        Outbox["OutboxPublisher"]
        Bus["PostgresEventBus<br/>(2 consumer groups)"]
        Engine["WorkflowEngine"]
        Proj["ProjectionWorker"]
    end
    PG[("Postgres")]
    HTTP --> PG
    Outbox --> PG
    Bus --> PG
    Engine --> PG
    Proj --> PG
```

## Key engineering problems this project actually solves

| Problem | Where | Verified how |
|---|---|---|
| Distributed consistency (DB commit vs. bus publish) | Transactional outbox ([ADR-003](docs/adr/ADR-003-transactional-outbox.md)) | Killed the live process mid-batch; zero events lost, zero duplicates |
| Duplicate delivery | Idempotency per layer ([ADR-005](docs/adr/ADR-005-idempotency.md)) | Same `eventId` POSTed 5×; exactly one row |
| Workflow recovery after a crash | Lease-based claiming, not in-memory state ([diagram](docs/diagrams/05-failure-recovery.md)) | Killed mid-workflow twice (pre-dispatch, and mid-saga); both resumed correctly |
| Saga compensation ordering | Orchestration, reverse-order compensation ([ADR-004](docs/adr/ADR-004-saga-orchestration.md)) | Forced a step to fail permanently; verified exact reverse-order rollback via `step_executions` |
| Event replay / rebuild | Per-consumer checkpoints (`consumer_checkpoints`) | A newly-added consumer group replays the full log from seq 0 automatically — observed live when Phase 03 added the workflow-trigger group |
| Scalability under load | Measured, not claimed ([Phase 06 notes](docs/phase-06-notes.md)) | 3,446 events/sec, p95 43.8ms — and two real bottlenecks found and fixed by measurement |
| Observability | Structured JSON logs today; OpenTelemetry planned for V2 | Every log line carries `level`, `msg`, `time` + context; correlation IDs flow through every event |

## Architecture decisions

| ADR | Decision |
|---|---|
| [001](docs/adr/ADR-001-modular-monolith-first.md) | Modular monolith first — service extraction deferred to an evaluated trigger |
| [002](docs/adr/ADR-002-postgres-as-event-bus.md) | Postgres as the event bus, with explicit Kafka trigger conditions |
| [003](docs/adr/ADR-003-transactional-outbox.md) | Transactional outbox for DB/bus consistency |
| [004](docs/adr/ADR-004-saga-orchestration.md) | Saga orchestration, not choreography |
| [005](docs/adr/ADR-005-idempotency.md) | Idempotency enforced per-layer, not by one generic mechanism |
| [006](docs/adr/ADR-006-cqrs.md) | CQRS, scoped — with its one documented exception |
| [007](docs/adr/ADR-007-sse-over-websockets.md) | SSE over WebSockets for a one-directional dashboard feed |
| [008](docs/adr/ADR-008-multi-tenancy.md) | Shared schema, single tenant-resolution chokepoint |
| [009](docs/adr/ADR-009-deployment-topology.md) | Build locally, ship pre-built images to a free-tier VM — found a real timing bug in production |

## Failure scenarios, demonstrated

Every one of these was actually triggered against the running system,
not simulated in prose — see the linked phase notes for the exact
commands and observed database state.

- **Kill the API process mid-batch of concurrent ingest requests** →
  zero events lost, zero duplicate outbox rows, publisher resumes on its
  first tick after restart. ([Phase 02](docs/phase-02-notes.md))
- **Kill the process before the outbox has even run once** → the event
  survives as a `pending` outbox row; a fresh process dispatches it
  immediately. ([Phase 03](docs/phase-03-notes.md))
- **Kill the process mid-saga**, with a fault injected → workflow state
  survives, fault-injection state correctly does not (it's demo
  scaffolding, not domain state) — the saga completes cleanly on restart.
  ([Phase 03](docs/phase-03-notes.md))
- **Force a step to exhaust all retries** → full backward compensation in
  exact reverse order, correctly skipping the step that never completed
  forward. ([Phase 03](docs/phase-03-notes.md))
- **A real bug in production code, caught by its own dead-letter queue**
  — a broken `ON CONFLICT` clause failed on every message; the consumer
  retried 5× per message with backoff, then dead-lettered and moved on,
  rather than getting stuck. ([Phase 03](docs/phase-03-notes.md))
- **A cross-tenant data leak, found before shipping** — the dead-letters
  dashboard route's first draft had no tenant filter at all. Fixed with a
  join before it reached main. ([ADR-008](docs/adr/ADR-008-multi-tenancy.md))
- **A workflow that finished but was never shown**, found on the live
  deployment — a projection refresh that only ran alongside new raw
  events missed a workflow whose steps completed slightly later via a
  separate consumer group, with no further events to trigger a re-check.
  Fixed to refresh unconditionally every tick; the orphaned workflow
  self-healed on the next poll with zero data loss.
  ([ADR-009](docs/adr/ADR-009-deployment-topology.md), [deployment notes](docs/deployment.md))

## Performance

Full method and honest numbers: [`docs/phase-06-notes.md`](docs/phase-06-notes.md).

| wave | concurrency | req/s | p50 | p95 | p99 |
|---|---|---|---|---|---|
| warmup | 10 | 493 | 16.1ms | 59.6ms | 80.1ms |
| moderate | 25 | 991 | 24.0ms | 44.1ms | 60.2ms |
| high | 50 | 1,960 | 20.3ms | 45.9ms | 55.8ms |
| burst | 100 | 3,446 | 28.2ms | 43.8ms | 54.3ms |

Two real bottlenecks were found by measurement and fixed — an N+1 query
pattern in the projection worker, and sequential (rather than concurrent)
processing in the workflow engine. One plausible fix (raising a batch
size) was measured and found to change nothing; that result is recorded
alongside the ones that worked, not edited out.

## Run it

The fastest way to see it working is the [live deployment](https://liveops.130-61-191-125.nip.io)
above — it bootstraps a demo API key automatically. To run it yourself:

```bash
docker compose up -d          # Postgres only in V1 — see note on port 5434 below
cp .env.example .env
npm install
npm run migrate
npm run --workspace apps/api seed:dev-tenant   # prints a dev API key — save it
npm run dev                                     # API on :3000
```

In a second terminal:

```bash
cd apps/web && npx next dev -p 3001             # dashboard on :3001
```

Open `http://localhost:3001/?apiKey=<key>` (or paste the key into the
connection bar manually). Click **"Send a new order"**, then **"Force
shipment to always fail"** and send another, to watch a saga complete and
then compensate live.

To run the load test yourself:

```bash
API_KEY=<key> DATABASE_URL=postgres://liveops:liveops_dev_password@localhost:5434/liveops \
  node tests/load/ingest-load-test.mjs
```

## Deliberately not built in V1

Stated here as scope discipline, not as gaps discovered too late:

- **Kafka / Redpanda** — Postgres is the event bus (ADR-002), with
  explicit trigger conditions written down for when to migrate, and the
  `EventBus` interface already shaped to make that migration a swap, not
  a rewrite.
- **Kubernetes, Terraform** — can't be demoed usefully on a portfolio
  budget and wasn't the point; the live deployment (ADR-009) is plain
  Docker Compose on one VM, and a local Docker Compose environment
  reproduces the same architecture.
- **An AI incident investigator** — only worth building against real
  telemetry (OpenTelemetry, V2), not as a RAG-over-self-written-runbooks
  demo that would just retrieve its own answer key.
- **Redis** — no measured need for caching or distributed locks yet;
  Postgres covers both at this scale.
- **Full event sourcing** — the event log is real and is what the
  projection worker consumes, but workflow state is a mutable row, not
  reconstructed from replayed events. See [ADR-006](docs/adr/ADR-006-cqrs.md)'s
  one documented exception.

## Known trade-offs, stated plainly

- The workflow-summary projection reads `workflow_executions` directly
  rather than being purely event-sourced (ADR-006) — the engine doesn't
  yet emit a per-transition domain event.
- The chaos panel's fault toggles are process-global, not scoped per
  tenant/execution — confirmed directly in Phase 03 by tracing a fault to
  the wrong concurrent execution. Fine for a solo demo, not for
  simultaneous use. Planned fix: a per-visitor sandbox tenant (V2).
- The SSE stream accepts the API key as a `?token=` query param (the
  browser's `EventSource` can't set headers) — fine locally
  ([ADR-007](docs/adr/ADR-007-sse-over-websockets.md)), a production
  deployment should use a short-lived scoped token instead.
- `npm audit` flags PostCSS advisories via Next's own dependency chain —
  dev-time only, not exploitable here (no untrusted CSS is processed).

## Repository structure

```text
apps/
  api/     Fastify API + all four in-process workers (ingest, outbox,
           event bus, workflow engine, projections)
  web/     Next.js dashboard — a genuinely separate deployable, calling
           the API over CORS, not a same-origin proxy
docs/
  adr/           architecture decisions, one per real trade-off
  diagrams/      Mermaid, kept in sync with what's actually built
  phase-*-notes.md   what was verified at each build phase, including
                     bugs found and fixes that didn't work
  screenshots/
tests/
  load/    the load test that found Phase 06's two bottlenecks
```

## Note on port 5432

The compose file publishes Postgres on host port **5434**, not 5432 — the
development machine this was built on already runs two other unrelated
Postgres containers on 5432 and 5433. If you deploy this elsewhere, 5432
is fine to use.
