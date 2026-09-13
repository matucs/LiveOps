# Observability

## Tracing (local only)

```bash
docker compose --profile observability up -d jaeger
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
```

Open http://localhost:16686, select service `liveops-api`. Send an event
and search for the `ingest.event` operation — the resulting trace spans
the full path (see ADR-011): HTTP → ingest → both consumer groups →
every workflow step → the two external-call spans, as one trace ID, even
though each of those stages runs in a separate async loop.

**Not run in production.** The deployed VM has ~1GB RAM total; there is
no headroom to also run a trace backend next to Postgres, the API, and
the dashboard. `OTEL_EXPORTER_OTLP_ENDPOINT` is unset there, and
`otel/register.mjs` no-ops completely when it's unset — zero overhead,
not a disabled-but-present cost.

## Logs (everywhere, including production)

Every log line is structured JSON (`shared/telemetry.ts`'s `log()`):

```json
{"level":"info","msg":"event ingested","time":"...","traceId":"...","spanId":"...","tenantId":"...","eventId":"..."}
```

`traceId`/`spanId` are included automatically whenever a span is active
(from `context.active()`), including in production where they're the
*only* way to find "every log line for this one request" — there's no
trace UI to click into there, but `grep` on a `traceId` across the
container's logs does the same job for a single-process deployment.

## Metrics

`GET /metrics` — Prometheus exposition format. Tracked:

- `liveops_http_requests_total` / `liveops_http_request_duration_seconds` (by route, status)
- `liveops_events_ingested_total` (by tenant)
- `liveops_workflow_completed_total` / `liveops_workflow_compensated_total` / `liveops_workflow_failed_total`
- `liveops_consumer_lag` (by group — event log position minus checkpoint)
- `liveops_dead_letters_open` (open, unreplayed count)
- `liveops_circuit_breaker_state` (by breaker name — 0 closed / 1 half-open / 2 open)

Scraping this in production costs a few KB per scrape and no extra
process — it's an in-process registry, unlike tracing. Not wired to a
Grafana instance in this deployment (another process this VM doesn't
have room for); `docker compose --profile observability` includes a
Prometheus container locally for anyone who wants to graph it.

## What "done" means here

Not: a dashboard with graphs. The plan's actual bar, met: *given a
failure, can you find out why from telemetry alone, without guessing?*
Every phase-notes.md bug in this project so far was found through logs,
direct SQL, or (from this phase on) a trace — not by reading source code
and hoping.
