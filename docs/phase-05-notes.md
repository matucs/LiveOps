# Phase 05 — Dashboard, SSE, Chaos Panel

## What's built

- `apps/web`: a separate Next.js app (App Router), genuinely a second
  deployable from `apps/api` — not a proxy or same-origin trick. It calls
  the API directly over CORS, locked to the web app's origin via
  `WEB_ORIGINS` rather than `*`.
- Live dashboard: total events, active/recent workflow count, open
  dead-letter count, a 30-minute throughput sparkline (hand-rolled inline
  SVG — a handful of points didn't justify a charting library), and a
  workflow list with per-step progress dots color-coded by outcome
  (green = succeeded forward, amber = rolled back, cyan = currently
  running).
- Chaos panel: the seven fault-injection actions from Phase 03's
  `chaos.ts`, now clickable instead of curl-only. Colour-coded by
  severity — the one-shot retry demos are neutral, the "always fail"
  toggles that force full compensation are red.
- Connection bar: API URL + key, stored in `localStorage`. Also accepts
  `?apiKey=...&apiUrl=...` on the page URL to bootstrap credentials
  directly — a genuinely useful feature (a shareable demo link), not just
  a testing convenience, added while trying to screenshot the connected
  state.

## SSE auth: a real design decision, not an oversight

The browser's native `EventSource` cannot set an `Authorization` header,
so the stream route alone accepts the API key as `?token=`, resolved
directly via a new `resolveTenant()` helper factored out of
`requireTenant`. Deliberately **not** folded into `requireTenant` itself:
a key in a query string is more likely to end up in a proxy or access log
than one in a header, so every other route keeps the stricter header-only
path. Documented in `sse.ts` as a local-demo trade-off — a production
deployment should mint a short-lived, scope-limited stream token instead
of accepting the raw API key.

## Verified

- CORS preflight against `localhost:3001` returns the expected
  `access-control-allow-origin`; a request with no `Origin` header (or the
  wrong one) is not granted access.
- SSE with `?token=<key>` returns a live snapshot; SSE with no token
  returns `401`.
- The exact SSE JSON shape was diffed field-by-field against what the
  React components destructure (`activity.event_count`,
  `workflows[].execution_id`, `throughput[].minute`, etc.) — confirmed to
  match exactly, rather than assumed from writing both sides at once.
- Screenshot of the rendered page (`docs/screenshots/dashboard-empty.png`)
  confirms layout, type hierarchy, and chaos-panel color coding render
  correctly in the empty/disconnected state.
- **Not independently screenshotted**: the fully-connected, data-populated
  state. Headless Chrome's one-shot `--screenshot` flag fires before the
  async `EventSource` connection resolves, and `--virtual-time-budget`
  doesn't reliably wait on real network I/O to a live local server; doing
  this properly needs real CDP tooling (e.g. Puppeteer), which isn't
  installed and wasn't worth pulling in for one screenshot. Confidence
  instead comes from the field-by-field JSON diff above plus every prior
  phase's direct API verification — the binding code is a direct,
  unconditional map from that JSON to these components.

## Known trade-off carried from Phase 03

The chaos panel's one-shot fault buttons are still process-global, not
scoped to a tenant or execution (see Phase 03 notes). Fine for a solo demo
against a quiet system; not fine if two people click "fail next payment"
around the same time. The fix (`Phase 09`'s per-visitor sandbox tenant) is
already on the V2 roadmap — flagged here again because it's the panel's
most visible limitation.

## Done-when, from the plan

> Click "fail shipment" and watch compensation walk backward through the
> step timeline without touching a terminal.

The panel and its wiring are in place and independently verified end to
end via curl in Phase 03 (the exact same `/api/v1/_dev/chaos` calls the
buttons make) and via the SSE data path in this phase. Not re-verified by
clicking the actual rendered button in a live browser session, for the
same headless-tooling reason above — the button's `onClick` is a
one-line, directly-typed call to the already-verified `triggerChaos()`
helper.

## Next: Phase 06 — load test

`apps/web` and `apps/api` are both real, running processes now. Next
session drives sustained load against `/api/v1/events`, records p50/p95/p99
and sustained events/sec, and identifies the actual bottleneck rather than
guessing at one.
