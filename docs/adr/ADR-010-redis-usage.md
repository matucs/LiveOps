# ADR-010: Redis — Not Used, No Measured Need Yet

## Context

The plan lists caching, rate limiting, distributed locks, and WebSocket
scaling as potential Redis use cases. Redis is also the reflexive
"add it, it's cheap and everyone uses it" choice for a portfolio project.

## Problem

Does any part of LiveOps actually have a problem Redis is the right
answer to, right now?

## Decision

Not yet. Checked each candidate use case against what's actually measured:

- **Caching.** Nothing in the read path is slow enough to justify it —
  Phase 06's load test found the bottlenecks were an N+1 query and
  sequential processing, both fixed in application code; no query latency
  problem remains that a cache would solve.
- **Rate limiting.** A real, honestly-documented gap (README's "known
  trade-offs") — but it needs a decision about *what* to rate limit (per
  API key? per tenant? per IP for the demo route?) before reaching for a
  specific store. A single Postgres table with a sliding window would
  work at this scale too; Redis isn't required by the problem, just
  conventional for it.
- **Distributed locks.** Every lock-shaped need in this system (outbox
  claiming, workflow execution claiming) is already solved with
  `FOR UPDATE SKIP LOCKED` and a `locked_until` lease directly in
  Postgres (ADR-003, the failure-recovery pattern) — introducing Redis
  locks alongside would be a second mechanism doing the same job the
  database already does correctly.
- **WebSocket scaling.** Moot — LiveOps uses SSE, not WebSockets
  (ADR-007), specifically because the dashboard's traffic is
  one-directional and doesn't need a stateful gateway to fan out through
  in the first place.

## Trade-offs

Adding Redis now would have cost nothing to demo and would tick a box on
a skills list. It would also be the exact anti-pattern the plan warns
against (§31: "use Redis without a clear purpose") — a real reviewer
asking "why is this here" deserves a better answer than "it's a common
choice."

## Consequences

- If per-tenant rate limiting is built, decide the mechanism on its own
  merits at that time rather than reaching for Redis by default — a
  Postgres-backed counter is the more consistent choice given every other
  piece of shared state in this system already lives there.
- This ADR is revisited, not silently ignored, if a future measurement
  (not a hunch) shows a caching or locking need Postgres doesn't already
  solve — the same discipline ADR-002 applies to the Kafka question.
