# Phase 01 — Foundation & Ingest

Verified manually on 2026-09-13:

- `docker compose up -d` → Postgres healthy (host port 5434 — see README).
- `npm run migrate` applied `001_init.sql` cleanly.
- Seed script created a tenant and a hashed API key, printing the raw key once.
- Same `eventId` POSTed 5 times: first request → `201`, `duplicate:false`;
  next four → `200`, `duplicate:true`. Confirmed via SQL: exactly one row in
  `events` and exactly one row in `outbox` for that `eventId`, despite 5 HTTP
  requests.
- No API key → `401 missing_api_key`. Wrong API key → `401 invalid_api_key`.
- Missing required field (`type`) → `400 invalid_event` with field-level
  detail from zod.

## Done-when, from the plan

> The same POST sent five times returns the same event ID five times and
> leaves exactly one row.

Met.

## Next: Phase 02 — outbox poller & consumer loop

The `outbox` table already fills correctly; nothing reads it yet. Next
session starts with the `EventBus` interface and its Postgres
implementation (`FOR UPDATE SKIP LOCKED`), then the dispatch loop with
retry/backoff and dead-lettering.
