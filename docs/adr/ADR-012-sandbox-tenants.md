# ADR-012: Per-Visitor Sandbox Tenants

## Context

Phase 03 documented a real, traced limitation: chaos fault-injection flags
were a single global state set, so with concurrent workflows in flight, a
one-shot fault meant for one execution could land on a different one
entirely — found live via `step_executions` (docs/phase-03-notes.md), not
theorized. Fine for a single person exploring the demo locally; wrong for
a public URL that multiple people can open at the same moment.

## Problem

How should the live deployment let a stranger safely break the system on
purpose, without one visitor's chaos-panel clicks corrupting another
visitor's view of the demo?

## Options Considered

**Fix the chaos flags' scope only** (e.g., key them by execution ID or
correlation ID instead of being global). Narrower blast radius, but
visitors sharing one tenant would still see each other's workflow
history and event counts intermixed on the dashboard — confusing even
without any fault injection involved.

**Per-visitor sandbox tenants.** Each browser gets its own tenant,
provisioned on first visit (`POST /api/v1/demo/sandbox`), with chaos
state now keyed by `tenantId` (`chaos.ts`). Two visitors are now
genuinely different tenants — isolated by the same mechanism (ADR-008)
that already isolates any two real tenants, not a special case built for
the demo.

## Decision

Per-visitor sandbox tenants, with chaos state scoped by tenant.

## What Deliberately Stays Global

The circuit breakers (`payment-provider`, `shipping-carrier`) are **not**
tenant-scoped. This is a considered choice, not an oversight: a circuit
breaker models a shared external dependency. If tenant A's fault
injection trips the breaker, tenant B's calls to that same simulated
dependency correctly fail fast too — a real payment provider outage
doesn't check which of your customers caused it. Tenant-scoping the
breakers would be modeling something that isn't true of the system this
represents.

## Verified

- `POST /api/v1/demo/sandbox` returns a fresh tenant + key, seeded with
  one real completed workflow immediately (not an empty dashboard on
  first paint).
- Automated regression test (`tests/failure/07-chaos-tenant-isolation.mjs`):
  two tenants trigger conflicting chaos state *concurrently* — tenant A
  forces a permanent shipment failure, tenant B does nothing. Tenant A's
  workflow ends `compensated`; tenant B's completes normally. This is the
  literal scenario Phase 03 found broken, now passing as an automated
  test rather than a one-off manual trace.
- `POST /api/v1/_dev/chaos` now requires the same tenant auth as every
  other route (previously unauthenticated and global) — verified: a
  request with no API key gets `401`.

## Trade-offs

A shared demo tenant (kept as a fallback: `GET /api/v1/demo/bootstrap`,
for an old bookmarked link) gives every visitor the same, ever-growing
history to look at — arguably a richer-looking demo over time. Per-visitor
sandboxes mean each visitor starts from a smaller, seeded baseline. Traded
deliberately for correctness: growing shared state that many strangers
can mutate concurrently is exactly the shape of bug this ADR exists to
close, not something to keep for a marginally busier-looking dashboard.

## Consequences

- `MAX_SANDBOX_TENANTS` (500) caps unbounded tenant creation from a
  careless script hitting the endpoint in a loop — a cheap safeguard, not
  real rate limiting (README's known trade-offs still names that gap
  honestly).
- Sandbox tenants and their data are never cleaned up automatically —
  acceptable at this scale and documented, not a production posture.
