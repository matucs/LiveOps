import Fastify from "fastify";
import { config } from "./shared/config.js";
import { log } from "./shared/telemetry.js";
import { registerIngestRoutes } from "./modules/ingest/routes.js";
import { pool } from "./db/pool.js";
import { OutboxPublisher } from "./modules/bus/outbox-publisher.js";
import { PostgresEventBus } from "./modules/bus/postgres-bus.js";
import { auditLogHandler } from "./modules/audit/handler.js";

const app = Fastify({ logger: false });

app.get("/healthz", async () => {
  await pool.query("SELECT 1");
  return { status: "ok" };
});

await registerIngestRoutes(app);

const outboxPublisher = new OutboxPublisher();
const eventBus = new PostgresEventBus();
eventBus.subscribe("domain.events", "audit-log", auditLogHandler);

if (config.runWorkers) {
  outboxPublisher.start();
  eventBus.start();
  log("info", "workers started", { workers: ["outbox-publisher", "event-bus:audit-log"] });
} else {
  log("info", "workers disabled (RUN_WORKERS=false)");
}

app.setErrorHandler((err, _req, reply) => {
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
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
