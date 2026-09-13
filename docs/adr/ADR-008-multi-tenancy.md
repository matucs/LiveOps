# ADR-008: Multi-Tenancy — Shared Schema, One Auth Chokepoint

## Context

Every tenant's data must be isolated from every other tenant's. LiveOps
needs this to be true for events, workflows, dead letters, and dashboard
reads — and needs it to be *checkable*, not just believed.

## Options Considered

**Database-per-tenant.** Strongest isolation, but heavy operational cost
(migrations, connection pooling, and backups all multiply per tenant) —
disproportionate to this project's scale and demo purpose.

**Shared schema, `tenant_id` column on every table**, with tenant
resolution happening in exactly one place. What we built.

## Decision

Shared schema. `tenant_id` is a required column on every tenant-scoped
table. Resolution from API key to tenant happens in exactly one function
(`requireTenant` / `resolveTenant` in
`apps/api/src/modules/tenant/auth.ts`) — every other route receives
`tenantId` as an explicit argument and is required to filter by it
directly; nothing re-derives a tenant from context deeper in the call
stack.

## Why This Is the Actual Guarantee, Not Just a Convention

Centralizing tenant resolution into one function makes "can tenant A see
tenant B's data" a one-file audit rather than a property that has to hold
across every route independently. It does not, by itself, guarantee every
query filters correctly — that's still a per-route responsibility, and
Phase 04 found a real instance of getting it wrong.

## A Real Isolation Bug, Found and Fixed

The dead-letters dashboard route's first draft had **no tenant filter at
all** — `dead_letters` has no `tenant_id` column of its own (it
references either an event or a workflow execution, never both), and the
first version of the query simply didn't account for that, returning
every tenant's failures to every tenant. Caught before shipping (Phase
04), fixed by joining through both possible references and filtering on
`COALESCE(events.tenant_id, workflow_executions.tenant_id)`. Documented
here rather than treated as a one-off bugfix, because it's exactly the
failure mode this ADR exists to name: an operational/debug table that
*feels* lower-stakes than business data is precisely where an isolation
check is easy to skip.

## Trade-offs

Shared schema means a single slow or malicious tenant can, in principle,
degrade shared infrastructure (connection pool, table locks) for others —
mitigated by per-tenant rate limiting (planned, not yet built — see
README's known trade-offs) rather than by the schema design. Database-per-tenant
would have avoided that specific risk at a much higher fixed operational
cost that this project's scale doesn't justify.

## Consequences

- Any new table holding tenant data must carry `tenant_id` and every
  query against it must filter by it — a checklist item for review, the
  same discipline ADR-005 asks for around idempotency.
- Any new dashboard/debug route is exactly the kind of place to
  re-check this deliberately, given the dead-letters precedent above.
