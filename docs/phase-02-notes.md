# Phase 02 — Outbox Publisher & Consumer Loop

Verified manually on 2026-09-13:

## Crash-resume test

1. Sent 250 events (`evt_batch_151`..`evt_batch_400`) concurrently against
   the running server.
2. `kill -9` the actual Node process ~30ms after firing the batch (targeted
   the real `node --require preflight.cjs ... server.ts` PID, not the `tsx`
   wrapper shell around it — the first attempt hit a wrapper PID that had
   already exited, which is worth remembering: `pgrep -f "tsx ...server.ts"`
   is not reliably the process actually holding open connections).
3. **State captured immediately after the kill** (before any restart):
   - 182 of the 250 events had landed (the rest never got a response —
     acceptable: a caller that doesn't receive `201`/`200` must retry, and
     retrying is exactly what idempotent ingest is for).
   - Outbox: 151 `dispatched`, 32 still `pending` — proof the publisher was
     killed mid-batch with unpublished work outstanding.
   - `audit_log`: 151 rows, matching the dispatched count exactly. Zero
     duplicate `(handler, event_seq)` pairs.
4. Restarted the server. On the very first poll tick:
   - Outbox publisher immediately claimed and dispatched the 32 orphaned
     `pending` rows (no manual recovery step — the `locked_until` lease
     never blocks a plain restart, only a live competing instance).
   - Consumer resumed from `consumer_checkpoints.last_seq` and caught up.
5. **Final state:** 183 total events (182 batch + 1 from phase 01),
   183 outbox rows all `dispatched`, **183** `audit_log` rows — exact match,
   **zero duplicates**.

## Done-when, from the plan

> `kill -9` during a batch, restart, and the batch completes with no lost
> events and no duplicated side effects.

Met. Not simulated — actually killed the process holding the DB
connections and consumer loop mid-flight.

## Design notes

- Retry uses exponential backoff with full jitter (`retry.ts`), capped at
  10s, max 5 attempts (`CONSUMER_MAX_ATTEMPTS`) before dead-lettering.
- A poison message cannot block a consumer group forever: after exhausting
  retries it's written to `dead_letters` and the checkpoint advances past
  it anyway.
- Checkpoint advances after *each* message, not per-batch — a crash
  mid-batch loses at most the in-flight message's progress, which is safe
  because handlers must be idempotent (the `audit_log` unique constraint is
  what makes that concretely true here, not just asserted).
- `RUN_WORKERS=false` disables the outbox publisher and consumer loops in
  a given process — the seam that lets these move to a separate worker
  process later without touching the module code (see ADR on service
  extraction strategy, to be written).

## Next: Phase 03 — workflow engine & saga

`EventBus`/`OutboxPublisher` are solid enough to build the workflow engine
on top of: a workflow starts by subscribing to a triggering event type,
and its step transitions are persisted the same way `audit_log` proved
side effects can be — durably, idempotently, resumably.
