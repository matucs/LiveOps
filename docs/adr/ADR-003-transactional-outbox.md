# ADR-003: Transactional Outbox

## Context

Ingest must both persist an event durably and make it visible to
consumers. The naive approach — write to the database, then separately
publish to the bus — has a well-known failure mode.

## Problem

What happens if the database commit succeeds but the publish step fails,
or the process crashes between the two? Either the event is lost (never
published) or, if publish-then-commit is tried instead, a consumer can
see an event whose transaction later rolls back.

## Options Considered

**Dual write** (`INSERT` then publish, as two independent operations).
Simplest to write, structurally unsafe: no atomicity between the two.

**Transactional outbox.** The event row and an `outbox` row are written
in the *same* database transaction (`apps/api/src/modules/ingest/service.ts`).
A separate poller (`OutboxPublisher`) later claims `pending` outbox rows
with `FOR UPDATE SKIP LOCKED`, marks them `dispatched`, and only that
transition is what makes a row visible to consumer groups.

## Decision

Transactional outbox.

## Trade-offs

The dual-write approach would have been less code and lower latency (no
polling delay between commit and dispatch). It is also incorrect: it can
lose events or, worse, publish events for a transaction that hasn't
committed. The outbox pattern adds a polling delay (`OUTBOX_POLL_INTERVAL_MS`,
250ms default) between commit and dispatch — real, bounded, and
explicitly a latency cost accepted in exchange for correctness.

## Failure Scenarios, and How the Design Answers Them

- **Publisher crashes mid-batch.** Claimed rows carry a `locked_until`
  lease, not a held transaction — a crashed publisher's claim simply
  expires, and the next poll (by this process on restart, or another
  instance) reclaims it. No separate recovery step exists or is needed;
  Phase 02 verified this directly by `kill -9`-ing the live server mid-batch.
- **Duplicate publish attempts.** The outbox's own state machine
  (`pending` → `dispatched`) means a row is claimed once per lease window;
  downstream, every consumer is required to be idempotent anyway (see
  ADR-idempotency), so even a duplicate dispatch is a safe no-op.
- **Business write succeeds, host dies before the outbox insert.**
  Impossible by construction — they're the same transaction.

## Verified

Phase 02: killed the live process ~30ms into a 250-event burst. At the
moment of death, 32 outbox rows were still `pending`. On restart, the
publisher dispatched them on its very first tick with no manual
intervention; final state was exactly 183 events / 183 dispatched / 183
downstream side effects, zero duplicates.

## Consequences

- Every future write path that needs to notify the async pipeline must
  follow this same pattern (business row + outbox row, one transaction) —
  documented here so it isn't quietly skipped under time pressure later.
- The outbox table is a queue, not an audit log — Phase 08 (V2) plans a
  retention/archival policy for `dispatched` rows once volume matters.
