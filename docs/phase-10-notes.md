# Phase 10 — The Postgres → Kafka Migration

See ADR-013 for the decision and the headline numbers. This is the full
investigation trail — three unrelated bugs, found in sequence, each one
uncovered by refusing to accept a confusing number at face value.

## Setup

Redpanda (`docker compose --profile kafka up -d redpanda`) — local only.
`KafkaOutboxPublisher` and `KafkaEventBus` satisfy the same `EventBus`
interface `PostgresEventBus` does; `EVENT_BUS_DRIVER=kafka` selects it at
process start. First end-to-end smoke test passed immediately: one event,
full trace through outbox → Kafka → both consumer groups → all 5
workflow steps → completed. The interface seam worked exactly as
intended from Phase 02.

## Round 1: a permanent-looking plateau

Ran the unmodified Phase 06 load test against Kafka mode. Ingest
performed comparably to Postgres. The drain check, though, plateaued at
lag=22 and never moved for the remaining ~40 seconds of its timeout.

**First check**: Kafka's own consumer-group admin view (`rpk group
describe`) showed `TOTAL-LAG 0` for both groups — Kafka itself believed
every message had been consumed. This ruled out a stuck consumer
immediately and pointed at the measurement, not the transport.

**Second check**: all outbox rows were `dispatched` — none pending. So
`KafkaOutboxPublisher` believed it had sent everything.

**The bug**: `KafkaOutboxPublisher` built its list of rows to mark
`dispatched` from *every claimed row in the topic group*, not from the
subset that actually produced a message in that batch — a row whose
event failed to join into `eventBySeq` would be silently skipped when
building the Kafka message but still marked dispatched. In this run every
event did join correctly (verified directly: the 22 "missing" events all
existed with correct data), so this exact bug wasn't the mechanism here —
but it was a real gap regardless, closed by building the dispatched-ID
list alongside message construction, and by checking `producer.send()`'s
per-partition `errorCode` explicitly instead of trusting a resolved
promise.

## Round 2: same plateau, unrelated cause

With that fix in place, re-ran the test. Same shape of plateau, this time
at lag=28. This ruled the first fix out as the mechanism (it hadn't
triggered — every send had reported success) and sent the investigation
looking for a completely different explanation.

**The actual bug**: `tests/load/ingest-load-test.mjs` — unchanged since
Phase 06 — builds each wave's event IDs from a per-wave counter that
resets to 0 every call. `warmup` sends IDs `_0`..`_199`; `moderate` sends
`_0`..`_999`, **silently resending every ID warmup already used**; `high`
resends everything moderate and warmup used; `burst` resends everything
from all three. Across the whole run, only 3,000 truly distinct events
(matching burst's own range) were ever created, but 6,200 HTTP requests
were sent — 3,200 of them guaranteed duplicates.

Those duplicates were correctly rejected by idempotency (the mechanism
worked exactly right) — but a duplicate rejection still calls
`nextval()` on the `events.seq` sequence before hitting the `ON CONFLICT
DO NOTHING`, consuming a sequence value with no row ever created (the
exact non-transactional-sequence gap documented in
`docs/phase-03-notes.md`, now understood to also apply *within* a single
ingest call, not just across process restarts). `max(events.seq)` was
therefore inflated past the true number of events any wave created, and
the drain check's target was unreachable by however many duplicate
sequence values fell in the unprocessed tail at measurement time.

**This means every load test run in this project prior to this fix,
Phase 06 included, was measuring drain time against an inflated
target.** The true per-event downstream cost is higher than previously
reported — not because anything got slower, but because a smaller
fraction of "6,200 requests" than assumed were ever real work. Fixed by
giving each wave's IDs a distinct prefix (`${RUN_ID}_${waveLabel}_${seq}`),
eliminating cross-wave collisions entirely.

## Round 3: a genuine reset, and a genuinely slower number

Re-ran with corrected IDs. **Drain time immediately changed shape**: it
now decreased continuously toward zero (proof the ID fix was the right
diagnosis) — but throughput and drain time both looked dramatically worse
than any prior run (burst throughput ~700 req/s vs. 3,000+; drain not
finishing in 60s with over 1,000 events still remaining).

**Suspected, then confirmed, cause**: this development database had
accumulated 27,000+ events and 137,000+ `step_executions` rows across
this entire multi-day project session, with zero maintenance. Comparing
new numbers against that increasingly bloated dataset was never a valid
before/after. Reset both Postgres (`docker volume rm`) and the Kafka
topic to genuinely empty, re-seeded, and re-ran both transports back to
back on identical, clean, current-codebase state. **Postgres: 45.1s and
45.5s on two separate clean runs** (reproducible) to drain 6,200 real
events — the first accurate measurement of this pipeline's true
downstream cost, meaningfully higher than the ~20–24s reported in earlier
phases, because those earlier numbers were unknowingly measuring a
duplicate-cushioned workload.

## Round 4: a small, real, honestly-unresolved residual

Clean Kafka run: drain again plateaued near the end, at 11, then (on a
repeat clean run) at 45, then 2 — inconsistent magnitude across runs,
which itself ruled out a fixed structural gap. **Verified conclusively,
every time**: `audit_log` and `workflow_executions` always showed the
full, correct count (6,200) regardless of what the checkpoint said, and
Kafka's own admin view always showed zero real lag. The actual system was
correct in every run; only this project's own dashboard-facing "shadow
checkpoint" bookkeeping under-reported.

**Considered and ruled out**: stray background processes. `node --watch`
leaves its parent supervisor alive even after the deep child on a port is
killed — six such zombies had accumulated across this session. All
killed, and the test still reproduced the plateau (magnitude 45 that
time) under a single, cleanly-tracked foreground process. Not the cause,
though worth fixing anyway (see "process hygiene," below).

**Working theory, applied as a real fix**: `KafkaEventBus`'s
`eachMessage` does two sequential DB round trips per message (the
handler, then the checkpoint write) with no explicit heartbeat between
them. At the default 10s `sessionTimeout`, sustained processing of a
multi-thousand-message backlog could plausibly starve the client's
background heartbeat long enough for the broker to decide the consumer
was dead and trigger a rebalance mid-catch-up — Kafka's own committed
offset would still advance correctly (proving no data loss), but this
project's own explicit checkpoint write for messages in flight at that
moment could be abandoned. Widened `sessionTimeout` to 45s and set an
explicit 3s `heartbeatInterval`. Re-ran clean: residual dropped from 45
to **2** — a ~95% reduction. Not zero. Reported as exactly that.

## Process hygiene, fixed along the way

Every load test and failure-suite run in this phase now starts the
server via the harness's own tracked background-task mechanism
(`run_in_background: true` + `TaskStop`), not `nohup ... & disown`. The
latter left six zombie `node --watch` supervisors alive across this
session — never proven to be the cause of the Kafka finding above, but a
real gap in how this whole project's manual testing was conducted, worth
naming rather than quietly fixing without comment.

## Full regression suite, both transports

All 7 automated failure scenarios (`tests/failure/run-all.mjs`) pass
under Kafka, including from a cold process start. One test
(`02-tenant-isolation`) initially failed on a cold Kafka start — not a
regression, but Kafka's consumer-group join/sync adding real latency the
Postgres transport's immediate-poll behavior doesn't have. Fixed by
widening that one test's timeout (15s → 30s) rather than papering over a
real, worth-knowing transport characteristic.

## What this phase actually demonstrates

Not "Kafka works" — a working demo was the easy 30% of this phase. The
value is in the four rounds above: a real bug in new code, a 6-phase-old
bug in the tool used to validate every prior performance claim in this
project, a bloated-dataset methodology trap, and a client-tuning issue
resolved to 95% rather than rounded up to "done." Every one of them was
found by treating a confusing number as a question to answer, not a
result to report.
