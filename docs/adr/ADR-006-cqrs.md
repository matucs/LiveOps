# ADR-006: CQRS — Where It Earns Its Place, and Where It Doesn't

## Context

The dashboard needs to answer questions ("how many events today", "which
workflows are running") that are expensive or awkward to answer directly
against the write-side tables (`events`, `workflow_executions`), especially
once those tables carry the full transactional/audit shape they need for
correctness rather than for fast reads.

## Problem

Should the dashboard query the write tables directly, or maintain
separate, purpose-built read models?

## Decision

CQRS, but scoped: a `ProjectionWorker` consumes `events` (its own
consumer group, own checkpoint — the same shape as every other consumer
in this system) and maintains three read tables
(`projection_throughput_minute`, `projection_tenant_activity`,
`projection_workflow_summary`). Every dashboard query route reads only
these tables — checkable, not just asserted (see the exception below).

## The One Documented Exception

`projection_workflow_summary` is refreshed by reading
`workflow_executions` directly, not purely from the event log. The honest
reason: the workflow engine (Phase 03) mutates a row per step transition
but does not *emit* a domain event for each transition. Building this
projection the "pure" way would require the engine to publish a
`workflow.step.completed`-shaped event for every step, which Phase 03
does not currently do. This is flagged as a real simplification in
`docs/phase-04-notes.md`, not hidden behind the ADR.

The dead-letters query route has a second, narrower exception: it joins
back to `events`/`workflow_executions`, but only to enforce tenant
isolation on a table with no `tenant_id` column of its own — an
access-control join, not a business-logic one.

## Consistency Model

Read models lag the write side by at most one consumer poll interval —
`CONSUMER_POLL_INTERVAL_MS`, 250ms by default locally. This is stated as
a number, not hand-waved as "eventually consistent": Phase 04 verified it
directly by capturing the SSE stream while concurrently POSTing a new
event, and watching `event_count` tick from 189 to 190 inside that
window.

## Trade-offs

Reading the write tables directly would have meant zero staleness and no
projection worker to build or reason about — at the cost of dashboard
queries competing with the write path for the same rows and indexes, and
every new dashboard need potentially requiring a new index tuned for a
read pattern the write-side schema wasn't designed around.

CQRS means an extra moving part (one more consumer group, one more thing
that can lag) in exchange for read models shaped exactly for what the
dashboard needs, decoupled from write-side schema changes, and — as
Phase 06 demonstrated — independently diagnosable when something is slow
(the projection worker's own lag was visible and fixable without touching
ingest or the workflow engine at all).

## Consequences

- Any new dashboard feature gets a new projection table and a corresponding
  update in `ProjectionWorker`, not a new query against write tables.
- If the workflow engine starts emitting per-step domain events in V2,
  `projection_workflow_summary` should be rebuilt to consume those
  instead of reading `workflow_executions` directly — at which point this
  ADR's one documented exception goes away, and that's worth closing the
  loop on explicitly rather than leaving the exception to go stale.
