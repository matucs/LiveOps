# LiveOps

A production-inspired, event-driven platform demonstrating distributed
systems, workflow orchestration, CQRS, reliability engineering, and
observability — built as a modular monolith first, evolving only where a
measurement justifies it.

**Status:** Phase 01 of V1 (see `docs/liveops-build-plan` for the full plan).
Ingest is live; outbox poller, workflow engine, projections, and the
dashboard are not yet built.

## What's here right now

- `POST /api/v1/events` — tenant-authenticated, schema-validated, idempotent
  event ingest, writing the event and its outbox row in one transaction.
- Postgres schema for the full V1 scope (events, outbox, workflow
  executions, step executions, dead letters, projections) — most tables are
  provisioned ahead of the code that will use them, matching the plan.

## Run it

```bash
docker compose up -d          # Postgres only in V1
cp .env.example .env
npm install
npm run migrate
npm run --workspace apps/api seed:dev-tenant   # prints a dev API key
npm run dev                                     # starts the API on :3000
```

Then, using the key printed by the seed script:

```bash
curl localhost:3000/api/v1/events \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"eventId":"evt_1","type":"order.created","payload":{"orderId":"ord_1"}}'
```

Sending the same `eventId` again returns `200` with `"duplicate": true`
instead of creating a second row — verified in `docs/phase-01-notes.md`.

## Architecture decisions

See `docs/adr/`. Written per-decision as each is made, not backfilled.

## Note on port 5432

The compose file publishes Postgres on host port **5434**, not 5432 — this
machine already runs two other unrelated Postgres containers on 5432 and
5433. If you deploy this elsewhere, 5432 is fine to use.
