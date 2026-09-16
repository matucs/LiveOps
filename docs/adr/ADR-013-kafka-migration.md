# ADR-013: The Postgres → Kafka Migration, Measured

## Context

ADR-002 chose Postgres as the V1 event bus and named explicit trigger
conditions for migrating to Kafka rather than treating it as inevitable.
This ADR is that migration, done to actually produce the promised
before/after measurement — not because a trigger condition fired (none
had, at this project's scale), but because "what would the numbers
actually show" is itself worth knowing and documenting honestly.

## What Was Built

A second, complete `EventBus` implementation (`KafkaOutboxPublisher`,
`KafkaEventBus`) satisfying the exact same interface `PostgresEventBus`
does — every caller (`audit-log`, `workflow-trigger`, `projection-worker`,
dead-letter replay) is unchanged, selected once at process start via
`EVENT_BUS_DRIVER`. Redpanda, not Apache Kafka, for local development —
a single binary speaking the real Kafka wire protocol, so `kafkajs` is
genuinely a Kafka client, without a separate broker/Zookeeper cluster for
a demo this size. **Local-only**: this stays out of the production
deployment. ADR-002's decision holds; this migration exists to produce
its evidence, not to reverse it.

## The Transactional Outbox, Unchanged in Shape

The pattern is identical to Postgres: claim pending outbox rows with
`FOR UPDATE SKIP LOCKED`, and only mark a row `dispatched` once the
transport has durably accepted it. The only thing that changes is what
"durably accepted" means — a Postgres status flip vs. a Kafka broker
acknowledging a produce (`acks: -1`, made explicit rather than left to
a client default). Partition key is `tenantId`, so one tenant's events
stay in order on one partition while different tenants can spread across
partitions — a real, named trade-off, not a default nobody chose.

## Three Real Bugs, Found by Actually Running the Comparison

This is the part of the migration that matters most. Getting a clean
number required understanding three separate, unrelated problems — one
in the new Kafka code, one in a 6-phase-old load-testing tool, and one in
Kafka client tuning. All three are documented in full in
`docs/phase-10-notes.md`; summarized here:

1. **`KafkaOutboxPublisher` could mark a row dispatched without ever
   producing a message for it**, if that row's event failed to join
   (`dispatchedIds` was built from all claimed rows, not from the rows
   that actually produced a message). Never triggered in practice — every
   claimed row's event always existed — but a correctness gap worth
   closing on its own terms, and closed with `producer.send()`'s
   per-partition error codes now checked explicitly rather than trusted
   from a resolved promise alone.
2. **The load-test script (`tests/load/ingest-load-test.mjs`, used
   unchanged since Phase 06) generated overlapping event IDs across its
   four waves** — each wave's own counter restarts at 0, so "moderate"
   silently resent every ID "warmup" already used, and so on. Those
   resends were correctly rejected as duplicates (idempotency working
   exactly as designed) — but a duplicate rejection still consumes a
   `BIGSERIAL` sequence value without creating a row (the same gap
   mechanism documented in Phase 03), inflating `max(events.seq)` past
   the true number of distinct events any wave actually created. Every
   prior load test run in this project, Phase 06 included, was measuring
   against a target inflated by this — the true per-event downstream cost
   is higher than previously reported. Fixed by giving every wave a
   distinct ID prefix.
3. **Kafka consumer sessions could time out under sustained backlog
   processing.** With the default `sessionTimeout` (10s) and no explicit
   heartbeat tuning, a consumer doing two sequential DB round trips per
   message across a multi-thousand-message backlog risked the broker
   deciding it was dead mid-catch-up. Never a correctness problem —
   verified repeatedly that every message's real side effect (an
   `audit_log` row, a completed workflow) landed regardless — but it left
   this project's own dashboard-lag bookkeeping under-reporting the true
   position by however many messages were in flight at the moment of a
   rebalance. Widening `sessionTimeout` to 45s and setting an explicit
   3s `heartbeatInterval` cut the discrepancy from 45 residual events to
   2, out of 6,200 — a ~95% reduction, not a total elimination, reported
   as exactly that rather than rounded up to "fixed."

## Measured Result (clean database, both transports, identical load test)

| | Postgres (V1) | Kafka (this migration) |
|---|---|---|
| Burst throughput (concurrency 100) | 2,103–3,369 req/s | 2,078–2,155 req/s |
| Burst p95 | 39–126ms | 122–128ms |
| Full drain, 6,200 real events | **45.1–45.5s** (reproducible) | ~46s to <10 events remaining, small residual (see above) |

**Ingest throughput is comparable between transports** — the bottleneck
this project already fixed in Phase 06 (the projection worker's N+1, and
sequential workflow-step processing) was in application code, not in
whichever transport carries the message, and that finding holds up
unchanged here. **Kafka does not make this specific pipeline faster** at
this scale and this workload shape — it adds a real consumer-group
join/sync cold-start cost (see the tenant-isolation test's timeout
finding, `docs/phase-10-notes.md`) that the Postgres transport, which
just polls immediately, doesn't pay.

## Decision

Stay on Postgres in production (ADR-002 unchanged). This migration
answers "what would we actually get" with real numbers instead of an
assumption: at this project's throughput, Kafka's operational cost (a
second piece of infrastructure, consumer-group tuning, a real cold-start
tax) is not bought back by a throughput or latency win. ADR-002's named
trigger conditions (multi-consumer fan-out outside this deployment,
partition-level ordering at a scale where single-table locking becomes
contended) remain the actual conditions worth watching for — this
migration didn't manufacture a reason to cross them, it measured what
crossing them would actually cost and gain.

## Consequences

- The `EventBus` interface did its job: this migration touched zero
  lines in `audit_log/handler.ts`, `workflow/engine.ts`, or
  `dead-letters/routes.ts`. That was the point of cutting the seam in
  Phase 02, validated here rather than assumed.
- `consumer_checkpoints` remains a Postgres-mode-native concept
  reused as a "shadow" value under Kafka for dashboard/metrics parity —
  the residual-2-events finding above is the direct cost of that
  choice. A cleaner design would read Kafka's own consumer-group offsets
  via its admin API for the dashboard when `EVENT_BUS_DRIVER=kafka`,
  not attempted here because it wouldn't change the ingest/throughput
  finding above, which is this ADR's actual point.
- If a future ADR does trigger Kafka in production, the
  `sessionTimeout`/`heartbeatInterval` tuning here, and the reason for
  it, transfers directly — don't rediscover it under production load.
