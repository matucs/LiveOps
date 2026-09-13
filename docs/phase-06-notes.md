# Phase 06 — Load Test

A custom Node script (`tests/load/ingest-load-test.mjs`) rather than
k6/autocannon: full control over unique `eventId`s per request (essential
— idempotency dedup would otherwise silently skew throughput numbers) and
custom drain-time instrumentation against `consumer_checkpoints`.

Four waves of increasing concurrency against `POST /api/v1/events`, then a
drain phase measuring how long the async pipeline takes to catch up.

**Hardware**: local dev machine, Postgres in Docker (single container, no
resource limits applied), API process un-pooled (single Node process).
These are local numbers, not a claim about any particular production
instance size — see "Targets vs. this hardware" below.

## What load testing actually found — two real bottlenecks, one false lead

This is the part of the plan that matters most: measurements, not
assumptions. Three iterations, in the order they actually happened.

### Bottleneck #1: projection worker N+1 (found, fixed, verified)

**Before.** Ingest itself scaled cleanly — up to ~3,700 req/s locally at
p50 25ms / p95 38ms / p99 77ms with 100 concurrent clients, zero errors.
But the async pipeline fell badly behind: after a 3,000-event burst, the
`projection-worker` consumer group was still 5,600+ events behind after
60 seconds, draining at roughly **9 events/second** — nowhere close to
keeping up with a pipeline that had just accepted thousands of events per
second.

**Diagnosis.** Checked each consumer group's lag independently rather
than treating "the pipeline" as one thing:

```
handler                              | lag
audit-log                            |   0
workflow-trigger:order-fulfillment   |   0
projection-worker                    | 3425
```

Only one of three consumer groups was behind. `refreshWorkflowProjection`
was issuing one `INSERT ... ON CONFLICT` per changed workflow row, in a
plain sequential loop, every tick. At demo scale (tens of rows) this is
invisible. At load-test scale (3,000+ workflow executions touched per
tick) it was 3,000+ sequential round trips competing for the same 10
connections every consumer group and the API shared.

**Fix.** One bulk `INSERT ... SELECT ... JOIN (VALUES ...) ON CONFLICT`
statement instead of a per-row loop — the `VALUES` list is bounded by the
number of distinct *workflow definitions* (currently one), not the number
of executions. See `apps/api/src/modules/projections/worker.ts`.

**Verified.** After the fix, all three consumer groups reached 0 lag
before I could even query it in isolation. Under a fresh, larger load
test (12,594 events, more than double the original), the whole
event-consumption pipeline fully drained in **23.5–28s**, vs. never
finishing within the original 60s timeout at a smaller volume. This
result is unambiguous — not a small percentage gain, a qualitative fix of
a pipeline that previously did not keep up at all.

### A tempting fix that measured as no better: batch size alone

With consumer-side lag fixed, ~2,900 workflow executions were still stuck
`running` after the log itself was fully drained — a second, distinct
bottleneck downstream of the first. The obvious guess: the workflow
engine's claim query was hardcoded to `LIMIT 10` executions per tick;
raise it.

**Made it configurable** (`WORKFLOW_ENGINE_BATCH_SIZE`, default 50) and
re-measured. **Result: no measurable difference** — both `LIMIT 10` and
`LIMIT 50` took ~20 seconds to drain ~2,900 running executions to zero,
with near-identical shape (slow at first, then rapidly accelerating as
the backlog shrank — the signature of a fixed-size claim against a
shrinking pool, regardless of what that fixed size actually is).

This is worth stating plainly rather than editing out of the record: a
plausible-sounding fix, implemented and measured, turned out to change
nothing. The reason, once looked for: `tick()` still processed its
claimed batch with a sequential `for...await` loop. Claiming more rows
per tick just made each tick take proportionally longer — the total
number of sequential DB round trips needed to finish all outstanding
step-transitions was unchanged either way.

### Bottleneck #2: sequential processing within a tick (found, fixed, verified)

**Fix.** Replaced the `for...await` loop with `Promise.all(rows.map(...))`
— each claimed execution touches only its own rows (distinct
`execution_id`), so there is no shared state between them and no
correctness reason for serial processing. The connection pool (max 10)
remains the real ceiling on effective concurrency, which is the honest,
documented limit — not raised blindly alongside this change.

**Verified.** Re-ran the full load test (12,594 events total by this
point). Consumer-side drain: 23.5s, matching the earlier run. Workflow
completion: **0 executions still `running` by the time I could check** —
down from ~2,900 stuck in `running` for a further ~20 seconds after the
same point in the previous run. The downstream backlog that motivated
this entire investigation is gone, not reduced.

## Final numbers (both fixes applied)

| wave | concurrency | req/s | p50 | p95 | p99 |
|---|---|---|---|---|---|
| warmup | 10 | 493 | 16.1ms | 59.6ms | 80.1ms |
| moderate | 25 | 991 | 24.0ms | 44.1ms | 60.2ms |
| high | 50 | 1,960 | 20.3ms | 45.9ms | 55.8ms |
| burst | 100 | 3,446 | 28.2ms | 43.8ms | 54.3ms |

Full pipeline drain (ingest → outbox → all 3 consumer groups → workflow
completion) after the burst wave: **~23.5 seconds for ~6,200 new events**,
zero workflows left incomplete.

## Targets vs. this hardware

The plan's stated targets: 1,000 events/sec locally under controlled
load, 10,000+ events/sec as an architectural target, p95 < 200ms for
simple operations. **Ingest met the first comfortably** (3,446 req/s at
p95 43.8ms, well under the 200ms bar) — on a single unpooled Node process
against a single-container Postgres with no tuning. The second is
explicitly an architectural target for the Kafka-based V2, not a claim
made about this V1 hardware.

## Bottleneck ranking, for anyone scaling this further

1. ~~Projection worker N+1~~ — fixed.
2. ~~Sequential per-execution processing~~ — fixed.
3. **Postgres connection pool (max 10)** — the current ceiling on
   workflow-processing concurrency. Untested past this point; raising it
   is the next lever, not applied speculatively here.
4. **Single Postgres container** — no read replicas, no partitioning.
   This is the wall V2's Kafka migration and any read-model scaling exists
   to move past, not a problem this phase attempts to solve.

## Method note

Every fix in this phase was applied because a measurement pointed at it,
and every fix was re-measured before being called done — including the
one that didn't work. That's the discipline this phase exists to
demonstrate, more than the specific numbers above.

## Next: Phase 07 — architecture docs & ADRs

Every phase so far has generated real decisions with real trade-offs,
documented inline in code and in these phase notes as they happened. The
last V1 phase turns that into the deliverable form: ADRs, diagrams, and a
README a reviewer can actually navigate.
