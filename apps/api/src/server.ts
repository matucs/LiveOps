import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./shared/config.js";
import { log } from "./shared/telemetry.js";
import { registerIngestRoutes } from "./modules/ingest/routes.js";
import { pool } from "./db/pool.js";
import { OutboxPublisher } from "./modules/bus/outbox-publisher.js";
import { PostgresEventBus } from "./modules/bus/postgres-bus.js";
import { KafkaOutboxPublisher } from "./modules/bus/kafka/kafka-outbox-publisher.js";
import { KafkaEventBus } from "./modules/bus/kafka/kafka-event-bus.js";
import type { EventBus } from "./modules/bus/types.js";
import { auditLogHandler } from "./modules/audit/handler.js";
import { WorkflowEngine } from "./modules/workflow/engine.js";
import { workflowDefinitions } from "./modules/workflow/registry.js";
import { registerWorkflowQueryRoutes } from "./modules/workflow/routes.js";
import { ProjectionWorker } from "./modules/projections/worker.js";
import { registerProjectionRoutes } from "./modules/projections/routes.js";
import { registerDashboardStream } from "./modules/projections/sse.js";
import { registerDemoRoutes } from "./modules/demo/routes.js";
import { registerDeadLetterRoutes } from "./modules/deadletters/routes.js";
import { BackpressureMonitor } from "./modules/ingest/backpressure.js";
import { GaugeUpdater } from "./modules/metrics/gauge-updater.js";
import { registry, httpRequestsTotal, httpRequestDuration } from "./modules/metrics/registry.js";

const app = Fastify({ logger: false });

// The dashboard (apps/web) runs on its own origin and calls this API
// directly rather than through a same-origin proxy — command/query API
// and UI are genuinely separate deployables, so CORS is the honest
// choice here, not a rewrite that hides the boundary. Locked to the
// configured web origin(s), not "*".
await app.register(cors, {
  origin: config.webOrigins,
});

app.get("/healthz", async () => {
  await pool.query("SELECT 1");
  return { status: "ok" };
});

app.addHook("onResponse", async (request, reply) => {
  // request.routeOptions.url is the route PATTERN ("/api/v1/workflows/:id"),
  // not the raw URL with real IDs interpolated — the label cardinality
  // that actually matters for a metrics backend.
  const route = request.routeOptions?.url ?? request.url;
  httpRequestsTotal.inc({ method: request.method, route, status: String(reply.statusCode) });
  httpRequestDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
});

app.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", registry.contentType);
  return registry.metrics();
});

const backpressureMonitor = new BackpressureMonitor(config.backpressure.outboxThreshold);
// Always runs, independent of RUN_WORKERS — this instance's ingest route
// needs backlog visibility even when the async workers live on a
// different process/instance entirely.
backpressureMonitor.start();

await registerIngestRoutes(app, backpressureMonitor);
await registerWorkflowQueryRoutes(app);
await registerProjectionRoutes(app);
await registerDashboardStream(app);
await registerDemoRoutes(app);

// Transport selection (ADR-002, ADR-013): same EventBus interface either
// way, chosen once at process start. Every caller below (audit-log,
// workflow-trigger, projection-worker, dead-letter replay) is written
// against the interface and doesn't know or care which one is live.
const usingKafka = config.eventBus.driver === "kafka";
const outboxPublisher = usingKafka ? new KafkaOutboxPublisher() : new OutboxPublisher();
const eventBus: EventBus = usingKafka ? new KafkaEventBus() : new PostgresEventBus();
eventBus.subscribe("domain.events", "audit-log", auditLogHandler);

await registerDeadLetterRoutes(app, eventBus);

const workflowEngine = new WorkflowEngine(eventBus);
for (const def of workflowDefinitions) workflowEngine.register(def);

const projectionWorker = new ProjectionWorker();
const gaugeUpdater = new GaugeUpdater();

if (config.runWorkers) {
  await outboxPublisher.start();
  eventBus.start();
  workflowEngine.start();
  projectionWorker.start();
  gaugeUpdater.start();
  log("info", "workers started", {
    driver: config.eventBus.driver,
    workers: ["outbox-publisher", "event-bus:audit-log", "workflow-engine", "projection-worker", "gauge-updater"],
  });
} else {
  log("info", "workers disabled (RUN_WORKERS=false)");
}

app.setErrorHandler((err: Error, _req, reply) => {
  log("error", "unhandled route error", { err: err.message, stack: err.stack });
  reply.code(500).send({ error: "internal_error", message: "Something went wrong." });
});

app.listen({ port: config.port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    log("error", "failed to start server", { err: err.message });
    process.exit(1);
  }
  log("info", "api listening", { address });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    log("info", "shutting down", { signal });
    await outboxPublisher.stop();
    await eventBus.stop();
    await workflowEngine.stop();
    await projectionWorker.stop();
    gaugeUpdater.stop();
    backpressureMonitor.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
