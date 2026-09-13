# ADR-002: Postgres as the Event Bus (with Explicit Kafka Trigger Conditions)

## Context

The plan's target architecture specifies Kafka for asynchronous
processing. Kafka is also the "obvious" choice — most system-design
references reach for it by default for this kind of workload.

## Problem

Do we need a dedicated broker on day one, or can Postgres carry the
event-bus role until a measurement says otherwise?

## Options Considered

**Kafka from the start.** Topics, partitions, consumer groups — the
target diagram's literal reading.

**Postgres as the transport**, behind an `EventBus` interface
(`subscribe(topic, group, handler)` / `start()` / `stop()`), implemented
with `FOR UPDATE SKIP LOCKED` for claiming and a `consumer_checkpoints`
table for per-group offsets — deliberately shaped to mirror Kafka
consumer-group semantics so a second implementation can satisfy the exact
same interface later.

## Decision

Postgres, behind the `EventBus` interface, with the migration to Kafka
planned as a V2 phase rather than assumed necessary.

## Trade-offs

Kafka gives independent scaling of the broker from the database,
proven high-throughput multi-consumer fan-out, and built-in partitioning.
It also means: a second piece of infrastructure to run and observe before
any load justifies it, and no way to test "is this actually necessary"
without building it first.

Postgres-as-bus gives: one fewer moving part locally, the option to use
real transactions where useful (the outbox insert *is* the publish, in
the same commit as the business write), and — the actual point — a
directly measurable answer to "where does this break."

## What We Measured

Phase 06's load test pushed **3,446 events/sec** through ingest (p95
43.8ms) and found the pipeline's actual bottlenecks were an N+1 query
pattern in the projection worker and sequential processing in the
workflow engine — both fixed in application code, **neither was a
broker-shaped problem**. The Postgres transport was not the limiting
factor at the load levels tested locally.

## Trigger Conditions for Migrating to Kafka

Not "eventually," specifically:

1. Sustained ingest load approaching Postgres's connection-pool ceiling
   even after the fixes above and reasonable pool tuning (Phase 06 names
   the pool, not the transport, as the next thing to measure).
2. A need for consumers outside this process/deployment to subscribe to
   the domain event stream (Kafka's multi-consumer fan-out is a genuine
   capability Postgres polling doesn't cleanly provide at scale).
3. A need for topic-level partitioning for ordering guarantees at a
   throughput where a single Postgres table's row-level locking becomes
   contended.

## Consequences

- The `EventBus` interface (`apps/api/src/modules/bus/types.ts`) is the
  seam. V2's Kafka implementation must satisfy it with zero changes to
  `audit-log`, `workflow-trigger`, or `projection-worker` — that's the
  test of whether the seam was cut in the right place.
- Partition-key design (per-tenant vs per-aggregate) is deferred to that
  migration, where it has a real ordering requirement to be evaluated
  against instead of being guessed at now.
- This ADR itself will be revisited, not silently superseded, when V2's
  migration happens — with the before/after numbers next to each other,
  the same way Phase 06 recorded a fix that didn't help alongside the
  ones that did.
