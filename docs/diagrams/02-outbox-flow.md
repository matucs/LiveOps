# Command & Outbox Flow

Traces one `POST /api/v1/events` from request to a downstream consumer
seeing it — the exact path ADR-003 (transactional outbox) exists to make
safe.

```mermaid
sequenceDiagram
    participant C as Caller
    participant API as Ingest route
    participant DB as Postgres
    participant Pub as OutboxPublisher
    participant Bus as PostgresEventBus<br/>(any consumer group)

    C->>API: POST /api/v1/events {eventId, type, payload}
    API->>API: validate envelope (zod)
    API->>DB: BEGIN
    API->>DB: INSERT events (ON CONFLICT DO NOTHING)
    alt event_id already existed
        DB-->>API: 0 rows returned
        API->>DB: SELECT existing row
        API->>DB: COMMIT
        API-->>C: 200 { duplicate: true }
    else new event
        DB-->>API: seq returned
        API->>DB: INSERT outbox (event_seq, topic='domain.events', status='pending')
        API->>DB: COMMIT
        API-->>C: 201 { duplicate: false }
    end

    loop every OUTBOX_POLL_INTERVAL_MS
        Pub->>DB: UPDATE outbox SET locked_by, locked_until<br/>WHERE status='pending' FOR UPDATE SKIP LOCKED LIMIT N
        DB-->>Pub: claimed rows
        Pub->>DB: UPDATE outbox SET status='dispatched'
    end

    loop every CONSUMER_POLL_INTERVAL_MS
        Bus->>DB: SELECT events JOIN outbox<br/>WHERE topic=? AND status='dispatched' AND seq > checkpoint
        DB-->>Bus: batch
        Bus->>Bus: handler(message) — retry w/ backoff on failure
        Bus->>DB: UPDATE consumer_checkpoints SET last_seq
    end
```

## Why this shape, specifically

- The event row and the outbox row commit **together** — a crash between
  them is impossible, not just unlikely (ADR-003).
- `locked_until` is a lease, not a held transaction — a publisher that
  dies mid-batch releases its claim automatically (verified in Phase 02
  by `kill -9`-ing the live process mid-batch: 32 rows still `pending` at
  the moment of death, dispatched on the very next tick after restart).
- The checkpoint advances **after each message**, not per-batch — a crash
  mid-batch loses at most the in-flight message's progress, which is safe
  because every handler is required to be idempotent (ADR-005).
