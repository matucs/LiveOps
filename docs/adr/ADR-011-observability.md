# ADR-011: Observability — Trace Context as Persisted Data, Not Ambient State

## Context

The plan asks for one continuous trace spanning "HTTP Request → Command →
Database → Outbox → Kafka → Consumer → Workflow → External Service." Every
stage after "Database" in LiveOps runs in a different async loop than the
one that handled the HTTP request — the outbox publisher, the event bus's
consumer groups, and the workflow engine each poll independently, on their
own timers, and the workflow engine may not even run in the same process
lifetime (a restart resumes leased work, per ADR-009's failure-recovery
pattern).

## Problem

OpenTelemetry's normal mechanism for connecting spans — an ambient
"active context" carried by `async_hooks` through a call chain — does not
survive any of those boundaries. By the time a workflow step actually
executes, there is no ambient context left pointing back to the HTTP
request that triggered it, possibly hundreds of milliseconds or (after a
restart) hours earlier.

## Options Considered

**Accept disconnected traces.** Each stage gets its own root trace, and a
human correlates them after the fact using `eventId`/`correlationId` in
the logs. Works, but is exactly the gap the plan's requested trace shape
calls out as not good enough.

**Persist the trace/span IDs as data on the row**, the same way this
project already persists workflow state, lease ownership, and consumer
checkpoints instead of keeping them in memory. `events.trace_id` /
`trace_span_id` are captured at ingest (inside the "ingest.event" span)
and copied onto `workflow_executions` at trigger time. Any later stage —
`bus.deliver`, a workflow step, a step's compensation — reads those
columns back and starts its own span as an explicit **remote child** of
that original span, via `withLinkedSpan()` (`apps/api/src/shared/telemetry.ts`).

## Decision

Persist trace context as data. It costs two nullable columns on two
tables and one small helper function, in exchange for a genuinely
continuous trace across every async and process-restart boundary in the
system — not simulated by correlating separate traces after the fact.

## Verified

Sent one event, fetched the resulting trace from Jaeger, and printed the
full parent/child tree with real timestamps:

```
POST (16.5ms)
└─ ingest.event (9.0ms)
   ├─ pg.query: BEGIN / INSERT / INSERT / COMMIT
   ├─ bus.deliver audit-log                              (+329ms)
   ├─ bus.deliver workflow-trigger:order-fulfillment      (+329ms)
   ├─ workflow.step .../validate-order                    (+572ms)
   ├─ workflow.step .../reserve-inventory                 (+582ms)
   ├─ workflow.step .../charge-payment                    (+589ms)
   │  └─ external.payment-provider
   ├─ workflow.step .../create-shipment                   (+596ms)
   │  └─ external.shipping-carrier
   └─ workflow.step .../notify-customer                   (+603ms)
```

One trace ID, 22 spans, spanning ~600ms across the outbox publisher's
tick, two independent consumer groups, and five sequential workflow
engine ticks — none of which share a call stack or an async context with
the original HTTP request.

## Trade-offs

The naive ambient-context approach would have needed zero schema changes
and worked correctly for anything that stays within one continuous
`await` chain — which is most systems, but not this one, on purpose
(ADR-001, ADR-004: independent workers are the whole point). Persisting
trace context is two extra nullable columns to keep populated on every
future write path that spans a similar boundary — a discipline documented
here so it isn't silently skipped when a new async stage is added later.

## Production Constraint

Real OpenTelemetry export (`OTEL_EXPORTER_OTLP_ENDPOINT`) is a
local-development-only capability, opted into via
`docker compose --profile observability up -d jaeger`. The deployed VM
(ADR-009) has ~1GB RAM total — no headroom for a trace backend alongside
Postgres, the API, and the dashboard. `otel/register.mjs` no-ops entirely
when that env var is unset, and production runs with it unset: structured
JSON logs (already carrying `traceId`/`spanId` whenever a span is active)
are what production observability actually is. See `docs/observability.md`.

## Consequences

- Every future async hand-off that should stay part of one trace needs
  the same treatment: persist `trace_id`/`trace_span_id` at the point the
  hand-off is written, read them back at the point it's picked up, wrap
  with `withLinkedSpan`. Not automatic — a discipline, not a framework
  guarantee.
- The Kafka migration (ADR-002's named trigger conditions) will need the
  same trace/span IDs carried as message headers or a JSON payload field
  instead of table columns — the pattern transfers, the storage mechanism
  changes.
