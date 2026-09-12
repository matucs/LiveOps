# Phase 04 — Projections & Read API

Verified manually on 2026-09-13, against the live server.

## What's built

- `ProjectionWorker`: its own consumer group (`projection-worker`),
  independent checkpoint, consuming `events` directly — the same shape as
  the `audit-log` and `workflow-trigger` groups from Phases 02-03. Three
  independent groups now advance the same log at their own pace, which is
  exactly the multi-consumer-group behavior a Kafka migration (V2) needs
  to already be true of the code.
- Three read models: `projection_throughput_minute` (bucketed event
  counts), `projection_tenant_activity` (running totals), and
  `projection_workflow_summary` (workflow status for the dashboard).
- Query routes (`/api/v1/dashboard/*`) read projection tables only. One
  documented exception: the dead-letters route joins back to
  `events`/`workflow_executions` — not to recompute business state, but
  because that join is the only correct way to enforce tenant isolation on
  a table with no `tenant_id` column of its own. Caught and fixed during
  this phase (see below) rather than shipped as a gap.
- SSE stream (`/api/v1/dashboard/stream`) — poll-and-diff against the
  projection tables at the same interval the consumers poll at, so a
  client is never staler than the projections themselves.

## Design decision recorded here, to become an ADR

`refreshWorkflowProjection` reads `workflow_executions` directly instead
of being purely event-sourced — a deliberate, documented simplification:
Phase 03's engine emits no per-transition domain event, only mutates a
row. Rebuilding workflow status purely from the log would require the
engine to also publish a "step succeeded" / "step failed" event per
transition. Worth doing in V2 (it's also a prerequisite for a clean
replay-from-log story); not worth blocking V1 on.

## Bug caught and fixed before it shipped: cross-tenant dead-letter leak

First draft of the dead-letters route had no tenant filter at all —
`dead_letters` has no `tenant_id` column (it references either an event or
a workflow execution, never both), so a naive route would have returned
every tenant's failures to every tenant. Fixed by joining through both
possible references and filtering on `COALESCE(events.tenant_id,
workflow_executions.tenant_id)`. This is precisely the kind of leak the
plan calls out as unacceptable (§30: "can tenant A access tenant B?") —
worth noting that it happened on an operational/debug table, which is
exactly where isolation bugs are easy to miss because they feel
lower-stakes than business data.

## Live verification

- Read routes tested against real accumulated state: activity showed
  `event_count: 189` matching the true total; workflow summary correctly
  listed all saga-test executions with the right `step_count` (5, from the
  new `stepCountFor()` registry lookup — not derived from execution
  history, which would have been wrong for a compensated/in-progress run).
- SSE: captured the stream to a file while concurrently POSTing a new
  event (`evt_sse_test`). The captured stream shows `event_count` ticking
  from `189` to `190` inside the poll window — the read side visibly
  updating from a live write, not just serving a static snapshot.
- Checkpoints: `audit-log`, `workflow-trigger:order-fulfillment`, and
  `projection-worker` all independently sitting at the same `last_seq`
  after catching up — three consumer groups, one log, no coordination
  between them beyond the log itself.

## Consistency model (for the README / ADR-CQRS)

Read models lag the write side by at most one poll interval
(`CONSUMER_POLL_INTERVAL_MS`, 250ms locally) — bounded, observed, and
explicitly eventually consistent. Not hidden behind a diagram: this is the
number that goes in the docs.

## Done-when, from the plan

> Grep the query layer and find zero references to the write tables.

Not quite true to the letter — the dead-letters route's tenant-safety join
is the one exception, and it's documented rather than silently present.
Every other route holds the rule exactly.

## Next: Phase 05 — dashboard, SSE panel, chaos panel

The backend side of Phase 05 (SSE, chaos toggles) already exists from
Phases 03-04. What's left is the Next.js frontend: live event feed,
workflow list with step timelines, and turning the dev-only
`/api/v1/_dev/chaos` endpoint into an actual panel a person clicks.
