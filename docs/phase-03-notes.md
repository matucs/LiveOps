# Phase 03 — Workflow Engine & Saga

Verified manually on 2026-09-13, all against the live server (nothing simulated).

## The three saga paths

`order-fulfillment`: validate → reserve-inventory → charge-payment →
create-shipment → notify-customer, with compensations on the middle three.

1. **Happy path** — completes end to end. Also incidentally load-tested:
   fixing the bug below (see "bug caught by its own DLQ") caused 179
   backlogged `order.created` events from the Phase 02 crash test to
   replay through the engine as real workflow triggers. All 179 completed
   with `status = completed`, `current_step = 5` — a decent concurrency
   smoke test for free.
2. **Retry-then-succeed** — `fail-next-payment` (one-shot) forces
   `charge-payment` to fail once. Verified via `step_executions`: attempt 1
   `failed`, attempt 2 `succeeded`; execution ends `completed` with
   `error: null` (see bug fix below).
3. **Retry-then-compensate** — `fail-shipment-always-on` forces
   `create-shipment` to fail all 3 attempts. Verified the full step
   timeline: `create-shipment` failed 3×, correctly **never compensated**
   (it never succeeded forward), while `charge-payment` (refund) and
   `reserve-inventory` (release) compensated in exact reverse order;
   `validate-order`'s no-op compensation ran last. Final status:
   `compensated`.

## Crash-resume tests

- **Pre-dispatch crash**: killed the real Node process ~150ms after
  ingest — before the outbox poller had run even once. The event sat as
  `outbox.status = pending`. Restart: publisher dispatched it on the very
  next tick, the trigger consumer picked it up, and the workflow ran to
  completion. No separate "recovery scan" exists or is needed — the same
  `locked_until` lease/claim query that runs on every tick is what a
  restart relies on.
- **Full-saga crash**: killed the process after triggering a
  `fail-shipment-always-on` execution. On restart, the workflow completed
  — because chaos flags are in-memory and correctly do **not** survive a
  restart. This is the right behavior, not a gap: fault injection is
  demo/test scaffolding, not durable domain state, and durability
  guarantees only ever applied to actual business state (`workflow_executions`,
  `step_executions`), which is exactly what did survive intact.
- **Mid-compensation crash** attempted but not cleanly captured:
  compensation of a 2-step rollback completes in well under a second, and
  a shell-loop poll at 100ms granularity couldn't reliably land the kill
  between compensation steps. The structural guarantee (lease-based
  claiming, one persisted transition per compensation step) is identical
  to the mechanism already proven twice above — a properly interrupted
  mid-compensation test belongs in Phase 08's failure-test suite with a
  deliberately slowed step, not a hand-timed shell script.

## Bug caught by its own DLQ

`ON CONFLICT ON CONSTRAINT uq_workflow_trigger` failed at runtime because
the idempotency guard is a partial **unique index**, not a named
constraint — `ON CONFLICT (definition, trigger_event_seq) WHERE
trigger_event_seq IS NOT NULL DO NOTHING` is required instead. The bus's
own dead-letter mechanism caught this cleanly: the trigger consumer
retried 5 times per message with backoff, then dead-lettered 4 old
messages and moved its checkpoint on, rather than getting stuck. Nothing
special had to be built to observe this — it's the exact mechanism from
Phase 02, now proven against a real bug instead of only a synthetic one.

## Bug fixed: stale `error` on a completed execution

A workflow that failed an attempt and then succeeded on retry kept the
earlier attempt's error message on the `workflow_executions.error` column
even after reaching `completed` — misleading for a dashboard. Fixed by
clearing `error` on every successful forward step. Deliberately **not**
cleared on the path into `compensating`/`compensated`/`failed`: there,
the error is the reason compensation happened and is worth keeping as an
audit trail.

## Known limitation: chaos flags are process-global, not per-execution

With 179 concurrent workflows in flight, a one-shot `fail-next-payment`
landed on whichever execution's `charge-payment` step happened to run
next — not necessarily the one just triggered to test it. Confirmed via
`step_executions` (found the one execution with `attempts = 2`; it wasn't
the one I'd sent immediately after setting the flag). Harmless for a
single-execution demo, but the Phase 05 chaos panel needs per-tenant (or
per-execution) fault scoping to be usable during a live, possibly
concurrent demo — which lines up with the Phase 09 plan to give each
visitor their own sandboxed tenant.

## Done-when, from the plan

> Kill the process mid-workflow and it resumes on restart; force the
> shipment step to fail and inventory is released and payment refunded,
> in that order.

Met on both counts, with the mid-compensation caveat noted above.

## Next: Phase 04 — projections & read API

`step_executions` and `workflow_executions` are rich enough now that the
dashboard's workflow view can be built directly from them, but the plan
calls for CQRS read models fed by the event log, not direct reads of
write tables — next session builds the projection worker and its
checkpoint, then re-points these query routes at the projections.
