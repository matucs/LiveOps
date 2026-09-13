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

## Not done in this phase, and why

- **Full automated failure test suite** (DB down, consumer crash mid-batch,
  etc.) — planned as the next sub-phase; everything verified so far was
  a manual, live, one-off test against the running dev stack, which is
  real verification but not a regression suite.
- **Tenant isolation as an automated test** — the isolation *mechanism*
  (ADR-008) is unchanged and was manually re-verified as part of the DLQ
  route's tenant-scoping join; a standing automated test is separate,
  planned next.
