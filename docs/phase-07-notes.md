# Phase 07 — Architecture Documentation

## What's built

- **8 ADRs** (`docs/adr/`), each written from a decision that was actually
  made and defended during the build, not backfilled to look
  comprehensive: modular monolith, Postgres-as-bus with named Kafka
  trigger conditions, transactional outbox, saga orchestration,
  per-layer idempotency, scoped CQRS, SSE over WebSockets, and
  multi-tenancy (including the real cross-tenant bug found in Phase 04).
- **5 Mermaid diagrams** (`docs/diagrams/`): container view, command/outbox
  flow, saga flow with compensation, CQRS flow, and a failure-recovery
  diagram that names the one lease-based pattern used identically by the
  outbox publisher, the event bus, and the workflow engine — drawn once,
  explicitly, instead of left implicit in three separate files.
- **Final README**: leads with the engineering problems actually solved
  and how each was verified, not with a feature list — matching the
  plan's own instruction (§32) to make that the first thing a reader
  sees.

## Why 8 ADRs, not the plan's original 14

The plan's initial ADR list included entries like
`ADR-003-kafka-vs-rabbitmq` in a document that had already mandated
Kafka elsewhere — writing that ADR would have meant justifying a
technology after committing to it, which is the exact anti-pattern §19
warns against ("never create an ADR merely to justify technology"). Every
ADR here corresponds to a decision this build actually had two live
options for, made a call on, and can point to code and (usually) a
measurement to defend.

## Diagrams vs. implementation — checked, not assumed

Before finalizing, cross-checked each diagram against the current source:

- Container diagram lists exactly the four in-process workers that
  `server.ts` actually starts (`outbox-publisher`, `event-bus:audit-log`,
  `workflow-engine`, `projection-worker`) — no aspirational components.
- CQRS diagram's dotted "documented exception" line matches the actual
  code path in `worker.ts`'s `refreshWorkflowProjection`.
- Saga diagram's compensation order (`charge-payment` → `reserve-inventory`
  → `validate-order`) matches the exact order verified live in Phase 03's
  `step_executions` query, not a generic "reverse order" gloss.

## One correction made while writing this phase

The original README (Phase 01) referenced `docs/liveops-build-plan` as a
repo file — it never was one; the build plan exists only as the published
planning artifact. Fixed to link the actual artifact URL instead of a
path that would 404 for anyone cloning the repo.

## Done-when, from the plan

> Each ADR must contain: Context, Problem, Options Considered, Decision,
> Trade-offs, Consequences.

All 8 follow this structure. Several also include a "Verified" or "A Real
Bug Found" section beyond the required structure — added because this
project's actual differentiator is that its trade-offs are backed by
things that were run and measured, not just reasoned about, and the ADR
format alone doesn't have a slot for that.

## V1 complete

Phases 01–07 are done. What exists right now, all verified live rather
than asserted:

- Idempotent, tenant-authenticated ingest with a transactional outbox.
- A Postgres-backed event bus with three independent consumer groups,
  retry with backoff, and dead-lettering that doesn't block a group.
- A workflow engine running a real saga with orchestrated compensation,
  crash-resumable via lease claiming with no separate recovery path.
- CQRS projections and a live dashboard over SSE, with a working chaos
  panel.
- A load test that found and fixed two real bottlenecks (and reported
  one fix that didn't work, honestly).
- 8 ADRs and 5 diagrams, cross-checked against the code they describe.

## What V2 would add, per the original plan

Not started, and explicitly out of V1 scope: OpenTelemetry tracing, a
full failure-test suite, a public deployment with per-visitor sandbox
tenants, and the measured Postgres→Kafka migration that ADR-002 already
names the trigger conditions for. See the build plan artifact for the
phase-by-phase breakdown.
