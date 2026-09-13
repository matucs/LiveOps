# ADR-009: Deployment Topology — Build Locally, Ship Images, Run on a Free-Tier VM

## Context

The plan calls for a live, demoable deployment on free or very low-cost
infrastructure, without spending months on it. The available host is an
Oracle Cloud Always Free VM: 2 vCPUs, ~1GB RAM, x86_64.

## Problem

~1GB of RAM is not enough headroom to safely run `npm run build` (a
TypeScript compile plus a Next.js/webpack production build) on the VM
itself without risking an OOM kill partway through a deploy.

## Options Considered

**Build on the VM**, the way `docker compose build` would normally work.
Simplest to script, but the actual risk observed on this box (954MB total
RAM, no swap by default) made it the wrong default.

**Build locally, ship pre-built images.** Build both production Docker
images on the local dev machine (verified to match the VM's x86_64
architecture first, not assumed), smoke-test them against a throwaway
local Postgres, then transfer via `docker save | gzip` → `scp` → `docker
load`. The VM's `docker compose` then only ever *runs* containers,
referencing pre-built `:prod` tags, never a `build:` directive.

## Decision

Build locally, ship images. Also added a 2GB swap file on the VM as a
safety margin for `apt`/Docker package operations, which independently
need more headroom than steady-state runtime does.

## Trade-offs

Building on the VM would mean one command (`git pull && docker compose up
--build`) instead of a local build-and-transfer step — simpler to
automate later as CI/CD. It also means every deploy carries real OOM
risk on this specific host, and a failed build partway through leaves the
VM in a worse state to debug than a failed local build does. Building
locally costs a slightly more manual redeploy process (documented in
`docs/deployment.md`) in exchange for never stressing the VM's memory
beyond steady-state container operation.

## Same-origin, not CORS, in production

The web app is built with `NEXT_PUBLIC_API_URL=""` (baked in at image
build time), so every request from the browser is a relative path
resolved against whatever domain served the page. Caddy splits traffic
by path (`/api/*` → the API container, everything else → the dashboard)
on one public domain. This isn't just simpler than configuring CORS for
production — it removes an entire class of "why is this request being
blocked" debugging from the public deployment, while local development
keeps the two-port, CORS-based setup from ADR-007 unchanged.

## A Real Bug This Decision Surfaced Indirectly

Deploying to a genuinely separate, quiet environment (as opposed to a
dev machine constantly generating background load-test traffic) is what
exposed a real timing bug in the projection worker: a workflow whose
steps complete slightly after its triggering event, with no further
events arriving afterward, was never re-projected. Invisible during
Phase 04-06 testing, which always had more traffic in flight. Found,
fixed, and redeployed within the same session — see `docs/deployment.md`
for the full account.

## Consequences

- Redeploying requires the exact architecture match documented in
  `docs/deployment.md` — if the VM's architecture ever changes (e.g. a
  future ARM-based Oracle shape), the local build step needs
  `docker buildx --platform linux/arm64` instead of a plain `docker build`.
- The manual build-and-ship process is a natural target for later CI/CD
  (build on a GitHub Actions runner instead of the local machine, publish
  to a registry, `docker pull` on the VM) — not built now because it adds
  registry-auth complexity this project's scope doesn't currently need.
