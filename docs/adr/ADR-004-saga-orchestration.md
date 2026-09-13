# ADR-004: Saga Orchestration (Not Choreography)

## Context

The `order-fulfillment` saga (validate → reserve-inventory →
charge-payment → create-shipment → notify-customer) needs to run multiple
steps and, on failure partway through, undo the steps that already
succeeded — in reverse order, exactly once each.

## Problem

Should the steps coordinate themselves by reacting to each other's
events (choreography), or should a central engine own the sequence and
drive it explicitly (orchestration)?

## Options Considered

**Choreography.** Each step publishes an event on completion; the next
step's handler listens for it and reacts. No central coordinator.
Compensation would mean each step also knows what event to listen for to
trigger *its own* undo.

**Orchestration.** A single `WorkflowEngine` (`apps/api/src/modules/workflow/engine.ts`)
owns `current_step`, drives each step via a `StepHandler` interface, and
— on exhausting a step's retries — walks previously-succeeded steps in
reverse, calling each one's `compensate()`.

## Decision

Orchestration.

## Trade-offs

Choreography scales better organizationally when many independent teams
own individual steps with no shared engine to coordinate through, and
avoids a central component that must itself be reliable. It also makes
one question hard to answer from any single place: "what has this
specific order actually done so far, and in what order should it be
undone?" — that answer would be scattered across each step's own event
history.

Orchestration means a single component (`WorkflowEngine`) is on the
critical path for every workflow — but it is also the single place that
answers that question, from one table (`step_executions`), which is what
made Phase 03's compensation-ordering logic possible to write, test, and
verify with a straightforward SQL query rather than reconstructed logic
spread across five step handlers.

## Compensation Semantics

- Compensation runs only over steps that **succeeded forward** — a step
  that never completed (exhausted its own retries) is correctly excluded,
  not compensated. Verified in Phase 03: `create-shipment` failed all 3
  attempts and was confirmed absent from the compensation timeline.
- Compensation runs in **exact reverse order** of forward completion, and
  each compensation step gets its own retry budget — a compensation that
  itself exhausts retries is dead-lettered (not silently dropped, not
  retried forever) and the execution ends `failed` rather than falsely
  reporting `compensated`.
- Compensations must be idempotent, exactly like forward steps — a crash
  mid-compensation replays the specific compensation step from the
  `step_executions` table, not from memory.

## Failure Scenarios

- **Process crashes mid-workflow.** The same lease mechanism as the
  outbox (`locked_until` on `workflow_executions`) means a restart
  reclaims exactly the executions a dead lease left behind — no separate
  recovery scan. Verified twice in Phase 03: a crash before the outbox
  even ran once, and a crash after a full saga (with fault injection)
  completed.
- **A step succeeds, but the process dies before persisting that.**
  Impossible by construction for the covered path — `step.execute()` is
  awaited, then its result and the `current_step` advance are persisted
  in the same query, before the lease is released.

## Consequences

- Every new workflow step must supply a real `compensate()` — even a
  no-op one (see `validate-order`, `notify-customer`) — so the engine
  never has to special-case "this step has nothing to undo."
- Eventual consistency is explicit: while a saga is `compensating`, reads
  through the projection may show a step's forward effect as having
  happened, briefly, before the compensation catches up. Documented, not
  hidden, in `docs/phase-04-notes.md`'s consistency-model note.
