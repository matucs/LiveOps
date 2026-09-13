// OpenTelemetry bootstrap. Plain JS, not TypeScript: it must load via
// `node --import` BEFORE anything else in the process, including the ESM
// loader that would otherwise let us write this in TypeScript. Auto
// instrumentation (pg, http) patches modules at require-time — if
// something has already imported 'pg' before this file runs, that
// import is cached and un-patched, which is exactly why this can't be
// "the first line of server.ts": by the time server.ts's own top-level
// code runs, its entire static import graph (including db/pool.ts's
// `import pg from "pg"`) has already been resolved and executed.
//
// Disabled entirely when OTEL_EXPORTER_OTLP_ENDPOINT is unset — the
// production VM (~1GB RAM) has no headroom to also run Jaeger, so this
// stays a local-development capability, not a production one. See
// docs/observability.md.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
  const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "liveops-api" }),
    traceExporter: new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    instrumentations: [new PgInstrumentation(), new HttpInstrumentation()],
  });

  sdk.start();
  console.log(JSON.stringify({ level: "info", msg: "opentelemetry started", endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }));

  process.on("SIGTERM", () => sdk.shutdown().catch(() => {}));
}
