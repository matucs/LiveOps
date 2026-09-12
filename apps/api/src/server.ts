import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./shared/config.js";
import { log } from "./shared/telemetry.js";
import { registerIngestRoutes } from "./modules/ingest/routes.js";
import { pool } from "./db/pool.js";
import { OutboxPublisher } from "./modules/bus/outbox-publisher.js";
import { PostgresEventBus } from "./modules/bus/postgres-bus.js";
import { auditLogHandler } from "./modules/audit/handler.js";
import { WorkflowEngine } from "./modules/workflow/engine.js";
import { workflowDefinitions } from "./modules/workflow/registry.js";
import { registerWorkflowQueryRoutes } from "./modules/workflow/routes.js";
import { ProjectionWorker } from "./modules/projections/worker.js";
import { registerProjectionRoutes } from "./modules/projections/routes.js";
import { registerDashboardStream } from "./modules/projections/sse.js";

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

await registerIngestRoutes(app);
await registerWorkflowQueryRoutes(app);
await registerProjectionRoutes(app);
await registerDashboardStream(app);

const outboxPublisher = new OutboxPublisher();
const eventBus = new PostgresEventBus();
eventBus.subscribe("domain.events", "audit-log", auditLogHandler);

const workflowEngine = new WorkflowEngine(eventBus);
for (const def of workflowDefinitions) workflowEngine.register(def);

const projectionWorker = new ProjectionWorker();

if (config.runWorkers) {
  outboxPublisher.start();
  eventBus.start();
  workflowEngine.start();
  projectionWorker.start();
  log("info", "workers started", {
    workers: ["outbox-publisher", "event-bus:audit-log", "workflow-engine", "projection-worker"],
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
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
