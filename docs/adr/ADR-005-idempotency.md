# ADR-005: Idempotency Strategy

## Context

Both the outbox and the workflow engine give **at-least-once** delivery —
a message can be redelivered after a crash before its checkpoint advances,
and a trigger event can arrive twice if a consumer's retry overlaps a
redelivery. Nothing in this system attempts exactly-once delivery, which
is not achievable in general across a network boundary; the correctness
requirement instead is: redelivery must never produce a duplicate
*business effect*.

## Problem

Where does idempotency actually need to be enforced, and by what
mechanism, at each of the three places redelivery can happen?

## Decision, by Layer

**Ingest.** `UNIQUE (tenant_id, event_id)` on the `events` table. A
duplicate `POST /api/v1/events` doesn't error — it looks up and returns
the original event, so calling the endpoint N times with the same
`eventId` has the same observable effect as calling it once. This is the
one enforced at the API boundary, because it's the one a real caller
(another service retrying a call that timed out) will actually trigger.

**Workflow triggering.** A partial unique index on
`(definition, trigger_event_seq)` on `workflow_executions`. A redelivered
trigger event cannot spawn a second execution of the same workflow for
the same triggering event.

**Consumer side effects.** No single generic mechanism — each handler is
required to make its own side effect idempotent, because the shape of
"idempotent" is specific to what the handler does. The demo consumer
(`audit_log`) does this with its own `UNIQUE (handler, event_seq)`
constraint; a real payment-charging step would do it by keying the
downstream charge on a value derived from the execution (not by
generating a fresh idempotency key per attempt, which would defeat the
purpose).

## Options Considered for the general mechanism

**A generic "processed message IDs" dedup table**, checked by every
consumer before acting. Rejected: it centralizes a decision
(what counts as a duplicate) that is actually different per handler —
"don't insert this audit row twice" and "don't charge this card twice"
are not the same check, and forcing them through one table either
under- or over-constrains one of them.

**Per-handler idempotency, enforced by whatever the handler is actually
writing.** What we built. More code per handler, but each handler's
idempotency guarantee lives right next to the effect it's guarding — a
unique constraint or key derived from that specific side effect, not a
shared, generic assumption imposed from outside.

## Verified

Phase 02: same `eventId` POSTed 5×, exactly one row in `events`, exactly
one row in `outbox`. Separately: killed the live server mid-batch of 250
concurrent requests; after restart, 183 events, 183 dispatched, and
exactly 183 `audit_log` rows — zero duplicates despite redelivery being
structurally possible (checkpoint hadn't advanced for the in-flight
message when the process died).

## Consequences

- Every new consumer handler added to this codebase must state, in its
  own code, what makes its specific side effect safe to run twice. This
  is a checklist item for code review, not something the framework
  enforces for you — a deliberate trade-off explained above.
- A handler that calls a genuinely non-idempotent external API (most
  payment gateways included) needs an idempotency key derived from stable
  data (e.g. `execution_id + step_name`), not generated per attempt — this
  is the harder, real version of the problem that the demo saga's
  logging-only steps don't have to solve, and is flagged explicitly in
  the README as a known simplification.
