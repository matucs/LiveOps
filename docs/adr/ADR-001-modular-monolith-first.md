# ADR-001: Modular Monolith First

## Context

LiveOps needs ingest, an outbox publisher, an event bus, a workflow
engine, projections, and a live dashboard API. The target architecture
diagram this project started from draws these as separate boxes (Rules
Engine, Workflow Engine, Notification Service, Analytics Service...),
which invites building them as separate deployables from day one.

## Problem

Should each of these run as its own service, or as modules inside one
process?

## Options Considered

**Microservices from the start.** Each concern (ingest, outbox, workflow
engine, projections) as its own deployable, communicating over the
network. Matches the target diagram literally.

**Modular monolith.** One process (`apps/api`), internally organized into
modules with explicit boundaries (`modules/ingest`, `modules/bus`,
`modules/workflow`, `modules/projections`), communicating in-process.
Workers are toggled by a config flag (`RUN_WORKERS`) rather than split
into separate binaries.

## Decision

Modular monolith. Every module was built against an interface that a
future service extraction would need anyway — `EventBus` (Phase 02),
`StepHandler` (Phase 03) — so the boundary is real in the code even
though the deployment is not yet split.

## Trade-offs

Microservices would have bought independent scaling and deployment from
day one, at the cost of: network calls (and their failure modes) where
in-process calls exist now, distributed tracing across service
boundaries before there's any real load to trace, and — critically for a
one-week build — far more infrastructure to stand up before the first
end-to-end path works.

The modular monolith cost nothing measurable so far: Phase 06's load test
found the actual bottlenecks were an N+1 query pattern and sequential
processing inside one process, not anything a service boundary would
have prevented or even revealed faster.

## Consequences

- Every module's public surface is a TypeScript interface + a folder
  boundary, not a network boundary — cheaper to get wrong, cheaper to fix.
- The three consumer groups (`audit-log`, `workflow-trigger`,
  `projection-worker`) already behave like independent services would
  (own checkpoint, own poll loop, no coordination between them beyond the
  shared log) — proving the boundary is right before paying to enforce it
  over a network.
- Extraction is deferred to a specific, evaluated trigger, not treated as
  inevitable. See the "Deliberately not building" section of the README
  and the service-extraction discussion carried in `docs/phase-04-notes.md`.
