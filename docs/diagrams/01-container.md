# Container Diagram — V1 (as built)

This reflects what actually runs, not the target architecture in the
original brief. No Kafka, no Redis, no separate worker processes — one
Postgres, one API process (four in-process workers), one Next.js app.

```mermaid
flowchart TB
    subgraph Client
        Browser["Browser<br/>(Next.js dashboard, apps/web)"]
        Caller["External caller<br/>(curl / another service)"]
    end

    subgraph API["apps/api — one Node process"]
        HTTP["Fastify HTTP layer<br/>(ingest, query, SSE, chaos routes)"]
        Outbox["OutboxPublisher<br/>(FOR UPDATE SKIP LOCKED)"]
        Bus["PostgresEventBus<br/>(consumer groups: audit-log, workflow-trigger)"]
        Engine["WorkflowEngine<br/>(lease-based claim + step execution)"]
        Proj["ProjectionWorker<br/>(own consumer group + checkpoint)"]
    end

    PG[("Postgres<br/>events · outbox · workflow_executions<br/>step_executions · dead_letters · projection_*")]

    Browser -- "REST + SSE (CORS)" --> HTTP
    Caller -- "REST" --> HTTP
    HTTP -- "read/write" --> PG
    Outbox -- "claim & dispatch" --> PG
    Bus -- "poll & checkpoint" --> PG
    Engine -- "claim, persist step transitions" --> PG
    Proj -- "consume events, upsert projections" --> PG
    HTTP -- "reads projection_* only" --> PG
```

## What's deliberately absent

- **Kafka / Redpanda** — Postgres carries the event-bus role in V1
  (ADR-002). The `EventBus` interface is the seam for a V2 swap.
- **Redis** — no caching or distributed-lock need has been measured yet;
  see ADR-010 (not yet written) for when it would be justified.
- **A separate worker process** — `RUN_WORKERS` toggles the four
  in-process workers without a code change, but nothing has forced
  splitting them out yet (ADR-001).
