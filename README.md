# LiveOps

A production-inspired, event-driven platform demonstrating distributed
systems, workflow orchestration, CQRS, reliability engineering, and
observability — built as a modular monolith first, evolving only where a
measurement justifies it.

**Status:** Phases 01-05 of V1 done (see `docs/liveops-build-plan` for the
full plan and `docs/phase-0X-notes.md` for what was actually verified at
each step, including two real bugs found and fixed along the way). Load
testing (Phase 06) and architecture docs/ADRs (Phase 07) are next.

## What's here right now

- **Ingest** — `POST /api/v1/events`: tenant-authenticated, schema-validated,
  idempotent (event + outbox row in one transaction; duplicates return the
  original instead of erroring).
- **Transactional outbox + Postgres event bus** — an `EventBus` interface
  with a Postgres implementation (`FOR UPDATE SKIP LOCKED`), so a Kafka
  implementation can satisfy the same interface later with zero caller
  changes. Retry with full-jitter exponential backoff; a poison message is
  dead-lettered without blocking its consumer group.
- **Workflow engine & saga** — a 5-step order-fulfillment saga with
  orchestrated compensation. Lease-based crash recovery: a restarted
  process needs no separate "recovery scan," it just reclaims whatever a
  dead lease left behind. Verified live by actually `kill -9`-ing the
  server mid-workflow (see `docs/phase-03-notes.md`).
- **Projections (CQRS)** — a dedicated consumer group feeds
  throughput/activity/workflow-summary read tables from the event log;
  the dashboard reads only these, never the write-side tables (one
  documented exception for tenant-safe dead-letter filtering).
- **Live dashboard** (`apps/web`, Next.js) — real-time event/workflow view
  over Server-Sent Events, plus a **chaos panel**: force a payment or
  shipment step to fail once (retries, then succeeds) or always (forces
  full backward compensation), live.

## Run it

```bash
docker compose up -d          # Postgres only in V1 — see note on port 5434 below
cp .env.example .env
npm install
npm run migrate
npm run --workspace apps/api seed:dev-tenant   # prints a dev API key — save it
npm run dev                                     # API on :3000
```

In a second terminal:

```bash
cd apps/web && npx next dev -p 3001             # dashboard on :3001
```

Open `http://localhost:3001`, paste the API key from the seed script into
the connection bar, click **Connect** — or open
`http://localhost:3001/?apiKey=<key>` directly. Use the chaos panel's
"Send a new order" button, then "Force shipment to always fail" and send
another, to watch a saga complete and then compensate live.

Or from the command line:

```bash
curl localhost:3000/api/v1/events \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"eventId":"evt_1","type":"order.created","payload":{"orderId":"ord_1"}}'
```

Sending the same `eventId` again returns `200` with `"duplicate": true`
instead of creating a second row.

## Architecture decisions

See `docs/adr/` (Phase 07 — not yet written). Design rationale that will
become ADRs is currently inline as code comments and in
`docs/phase-0X-notes.md`; nothing here is backfilled after the fact.

## Known trade-offs, stated plainly

- The workflow-summary projection reads `workflow_executions` directly
  rather than being purely event-sourced — the engine doesn't yet emit a
  per-transition domain event. Documented in `docs/phase-04-notes.md`.
- The chaos panel's fault toggles are process-global, not scoped per
  tenant/execution — fine for a solo demo, not for concurrent use. Planned
  fix: a per-visitor sandbox tenant (V2).
- The SSE stream accepts the API key as a `?token=` query param (the
  browser's `EventSource` can't set headers) — fine locally, a production
  deployment should use a short-lived scoped token instead.
- `npm audit` flags PostCSS advisories via Next's own dependency chain —
  dev-time only, not exploitable in this app (no untrusted CSS is
  processed). Not fixed yet to avoid a breaking Next major mid-build.

## Note on port 5432

The compose file publishes Postgres on host port **5434**, not 5432 — this
machine already runs two other unrelated Postgres containers on 5432 and
5433. If you deploy this elsewhere, 5432 is fine to use.
