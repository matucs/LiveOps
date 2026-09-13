# Deployment

LiveOps is live at **https://liveops.130-61-191-125.nip.io** — a free-tier
Oracle Cloud VM (Ubuntu 24.04, x86_64, 2 vCPU, ~1GB RAM), the same
low-cost-portfolio pattern used elsewhere: real `docker compose`, real
Caddy, real Let's Encrypt TLS via a `nip.io` domain (no purchased domain
needed).

## Why build images locally instead of on the VM

At ~1GB RAM, running `npm run build` (TypeScript + Next.js/webpack) on the
VM itself risked OOM. Both production images are instead built locally
(matching x86_64 architecture — verified before starting, not assumed),
smoke-tested against a throwaway local Postgres, then shipped to the VM
as compressed tarballs (`docker save | gzip`, `scp`, `docker load`) —
the VM only ever *runs* containers, never compiles anything.

## Topology

```
Internet → Caddy (host, :80/:443, auto TLS)
             ├─ /api/*, /healthz → 127.0.0.1:3000 (api container)
             └─ everything else  → 127.0.0.1:3001 (web container)

api container ↔ postgres container (docker network, not published publicly)
```

Same-origin in production: the web app is built with
`NEXT_PUBLIC_API_URL=""` (the Dockerfile's default), so every dashboard
request is a relative path resolved against whatever domain Caddy served
the page from. No CORS is involved in production at all — CORS
(`WEB_ORIGINS`) only matters for local dev, where the API and dashboard
run on two different ports. See `apps/web/src/lib/api.ts`.

## Resource tuning for a ~1GB-RAM host

- 2GB swap file added (`/swapfile`) — safety margin for `apt`/Docker
  operations, not for steady-state runtime.
- Postgres: `shared_buffers=64MB`, `max_connections=40`, `mem_limit: 300m`.
- API and web containers: `mem_limit: 250m` / `200m`.
- Poll intervals doubled in production (`CONSUMER_POLL_INTERVAL_MS` /
  `OUTBOX_POLL_INTERVAL_MS` = 500ms, vs. 250ms locally) — halves baseline
  query load from the four poll loops sharing this small box; the local
  load-test numbers in `docs/phase-06-notes.md` don't directly transfer
  to this hardware and aren't claimed to.

## Public demo tenant

A tenant named "Public Demo" is seeded once at deploy time
(`seed-dev-tenant.js "Public Demo"`), and its raw API key is set as
`DEMO_API_KEY` on the API container. A new, unauthenticated route
(`GET /api/v1/demo/bootstrap`) returns that key so a visitor's browser can
fetch real credentials automatically on page load
(`apps/web/src/app/page.tsx`) instead of requiring anyone to run a seed
script or paste a key to see the dashboard working. Scoped deliberately:
one low-privilege demo tenant, not a way to mint arbitrary credentials.

## A real bug this deployment found

The projection worker's `refreshWorkflowProjection` only ran inside the
branch that also found new raw events (`if (events.length === 0) return
false` skipped it entirely otherwise). Workflow step transitions happen
via a *separate* consumer group and the engine's own tick, slightly later
than the triggering event — so a single quiet event's workflow could
finish all 5 steps just after this tick had already returned early, with
no further events ever arriving to trigger another refresh. Verified live
here: the first demo event's workflow completed correctly (confirmed via
`workflow_executions` directly) but never appeared in
`projection_workflow_summary` or the dashboard.

Fixed by moving the refresh call outside the early return so it runs
every tick unconditionally — cheap regardless of backlog size since
Phase 06's bulk-upsert fix. Rebuilt, redeployed, and verified: the
orphaned workflow appeared on the very next tick with no data loss, and a
fresh isolated event afterward projected correctly on its own.

This is the same discipline as every other phase in this project — a
real environment surfaced a real gap that local testing hadn't, it got
fixed, and it's documented here rather than quietly patched.

## Files

- `infrastructure/docker/docker-compose.prod.yml` — the production
  compose file (uses pre-built `:prod` image tags, not `build:`).
- `infrastructure/docker/.env.production.example` — template; the real
  `.env.production` (with the actual Postgres password and demo key)
  lives only on the VM, never in this repo.
- `infrastructure/caddy/Caddyfile` — path-based reverse proxy config.
- `apps/api/Dockerfile`, `apps/web/Dockerfile` — multi-stage builds; the
  web image uses Next's `output: "standalone"` to minimize runtime size
  on the small VM.

## Redeploying

```bash
# Build + save (local machine, matching the VM's architecture)
docker build -f apps/api/Dockerfile -t liveops-api:prod .
docker build -f apps/web/Dockerfile -t liveops-web:prod .
docker save liveops-api:prod | gzip > liveops-api.tar.gz
docker save liveops-web:prod | gzip > liveops-web.tar.gz
scp liveops-api.tar.gz liveops-web.tar.gz liveops-vm:~/liveops/

# On the VM
cd ~/liveops
gunzip -c liveops-api.tar.gz | docker load
gunzip -c liveops-web.tar.gz | docker load
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```
