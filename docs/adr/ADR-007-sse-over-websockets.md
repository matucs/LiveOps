# ADR-007: Server-Sent Events, Not WebSockets

## Context

The dashboard needs live updates: event counts, workflow status, dead
letter counts. All of these flow server → client; nothing the dashboard
needs to send back to the server needs to travel over the same live
channel (chaos-panel actions and the "send a demo event" button are
regular `POST` requests).

## Problem

WebSockets are the reflexive choice for "live dashboard," and the
plan's target diagram names a "WebSocket Gateway" explicitly. Does this
project need one?

## Decision

Server-Sent Events (`GET /api/v1/dashboard/stream`), not WebSockets.

## Trade-offs

WebSockets are bidirectional and lower-latency for genuinely two-way
traffic, and are the more familiar choice to reach for by default. They
also require: a connection upgrade handshake, manual reconnect logic on
the client, and — the one that actually matters for the target
diagram — a separate stateful "gateway" component to scale independently,
solving a problem this dashboard doesn't have, because it has no
bidirectional traffic to carry.

SSE, for a one-directional feed: plain HTTP (works through the same
CORS/proxy/load-balancer story as every other route, no upgrade
negotiation), automatic reconnection built into every browser's
`EventSource`, and no separate component — it's a route on the same
Fastify app as everything else.

## Implementation Note

The stream is poll-and-diff against the projection tables
(`apps/api/src/modules/projections/sse.ts`), not a push triggered by the
projection worker itself — simpler, and the projection tables are already
the cheap, indexed thing to poll. The interval matches
`CONSUMER_POLL_INTERVAL_MS`, so a client is never more stale than the
projections themselves already are (see ADR-006's consistency model).

One real complication this created: the browser's native `EventSource`
cannot set an `Authorization` header, so this one route accepts the API
key as `?token=` instead of a header — see the code comment in `sse.ts`
and `docs/phase-05-notes.md` for why that's scoped to this route alone
rather than weakening auth everywhere.

## Consequences

- If a future feature needs the client to push something over the same
  live channel (not just via a separate `POST`), that's the trigger to
  revisit this decision — not a hypothetical future need, a concrete one.
- Scaling this past one process (multiple API instances behind a load
  balancer) means the projection tables — not any in-memory connection
  state — remain the single source of truth each instance polls, so no
  sticky-session requirement is introduced by this design.
