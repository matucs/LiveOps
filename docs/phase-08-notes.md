# Phase 08 — Reliability Made Visible (V2)

Three sub-phases, committed separately as each was verified live:

## 1. Tracing, metrics, circuit breakers

See ADR-011 for the trace-context-propagation design and the verified
22-span, one-trace-ID result. Circuit breakers on the two external-shaped
saga steps, verified live: forcing 3 consecutive payment failures
actually opened the breaker (`liveops_circuit_breaker_state{breaker="payment-provider"} 2`),
and the next attempts failed fast with `CircuitOpenError` rather than
paying the full timeout-and-retry cost. Prometheus `/metrics` verified
against real traffic, not just wired up and trusted.

## 2. Dead-letter replay

Scoped honestly: only consumer-sourced dead letters (`source LIKE
'consumer:%'`) are replayable via `POST /api/v1/dead-letters/:id/replay`,
which re-invokes the exact registered handler for that group
(`PostgresEventBus.getHandler`). Workflow-compensation dead letters
return `501` rather than a silent no-op — replaying one safely means
reopening a terminated state machine and re-deriving remaining attempts,
which is a real feature this phase doesn't attempt to half-build.

**Verified on real historic data, not synthetic**: replayed dead letter
`#4` — one of the four rows from Phase 03's `ON CONFLICT` bug, dead
enough that its underlying event (`evt_batch_13`, from Phase 02's crash
test) never got its workflow triggered at all. Replaying it today
actually spawned and completed that missing workflow, over a session's
worth of history later. Confirmed idempotent (replaying twice returns
`409 already_replayed`) and tenant-scoped (same join pattern as the
Phase 04 dead-letters route fix).

Dashboard: a live DLQ panel with a working Replay button, screenshotted
against the real remaining dead letters.

## 3. Backpressure

`BackpressureMonitor` polls the outbox's pending-row count every 2s
(cheap — `idx_outbox_pending` covers it) and sheds new ingest with `503`
+ `Retry-After` once it crosses a threshold, rather than accepting
requests onto a pipeline that's already behind. Runs independent of
`RUN_WORKERS`, since an API instance needs backlog visibility even if its
own workers are disabled and running elsewhere.

**Verified live**, not just asserted: set the threshold to `1` and
disabled workers (so the outbox would never drain), then sent three
events in sequence. First: `201`. Second and third: `503 overloaded`
with the real backlog count. Restarted with workers enabled and the
threshold at its normal value — the backlog drained immediately and
ingest resumed accepting requests.

## A real bug found while testing backpressure

Testing backpressure meant deliberately running with tracing **off**
(`OTEL_EXPORTER_OTLP_ENDPOINT` unset) to isolate the backpressure
behavior. That surfaced a real gap in `currentTraceContext()`: OTel's
no-op tracer (used whenever no SDK is running) still returns a span from
`startActiveSpan`, carrying the spec's reserved all-zero "invalid"
`SpanContext` — not `undefined`. The code was checking only for a
present span, not a *valid* one, so an event ingested with tracing off
persisted that all-zero ID as if it were a real trace. Re-enabling
tracing afterward and processing that row, `withLinkedSpan` tried to
extend the unextendable invalid context and (correctly, per the OTel
spec's behavior for an invalid parent) fell back to a fresh trace ID
**per step** instead of one shared trace — verified directly: five
workflow steps for one execution logged five different `traceId`s.

Fixed with `trace.isSpanContextValid()` before persisting. Verified: a
fresh event's five steps now log the exact same `traceId` throughout.
Documented here rather than silently patched, because it's precisely the
kind of interaction (a feature test run under conditions that happen to
disable a different feature) that only surfaces by actually running
things, not by reading the code.

## 4. Automated failure test suite

`tests/failure/run-all.mjs` — six scenarios, each turning a manual,
one-off verification from earlier phase notes into something that
regresses loudly instead of silently:

| # | Scenario | What it actually does |
|---|---|---|
| 01 | Duplicate event | Same `eventId` POSTed 5×, asserts exactly 1 row and the right response shape each time |
| 02 | Tenant isolation | Two real tenants, one populated with real events/workflows; asserts the other sees zero of it and gets 404 fetching the first tenant's execution ID directly |
| 03 | Saga compensation ordering | Forces permanent shipment failure, asserts the exact reverse compensation order via `step_executions`, and that the step which never succeeded forward is excluded |
| 04 | Circuit breaker | Forces 3 consecutive payment failures, asserts `/metrics` shows the breaker open (state=2) |
| 05 | Process crash mid-burst | Spawns its own API instance on a separate port, kills it `-9` mid-flight, restarts, asserts zero duplicate events and every landed event's workflow completed |
| 06 | Database unavailable | Stops the real Postgres container mid-test, asserts ingest fails with a clean 5xx (not a hang), restarts Postgres, asserts ingest recovers with no manual intervention |

Run: `docker compose up -d postgres && npm run dev` (in another terminal),
then `node tests/failure/run-all.mjs`.

### A test that passed for the wrong reason, caught before it shipped

The first version of scenario 05 used a fixed `sleep(15)` between firing
the request batch and sending `SIGKILL`. On this machine, that consistently
let **zero** events land before the kill — so the test's own assertions
(0 duplicates, 0 completed workflows out of 0 events landed) were
trivially true without exercising crash recovery at all. It reported
`PASS` for a scenario that never actually happened.

Fixed by polling for a real landed row (`intervalMs: 2`) instead of
guessing a fixed delay, and adding an explicit assertion
(`beforeRestart.rows[0].n > 0`) that fails loudly if nothing landed
before the kill — the exact failure mode just found. Re-run: 6-7 of 60
events consistently land before the kill now, a genuine partial-crash
scenario, with 0 duplicates and every landed event's workflow completing
after restart.

This is worth stating plainly: a test suite is also code, and "it says
PASS" is not the same claim as "it tested what it claims to." The fix
above is exactly the kind of thing this whole project's discipline exists
to catch.
