import Fastify from "fastify";
import { config } from "./shared/config.js";
import { log } from "./shared/telemetry.js";
import { registerIngestRoutes } from "./modules/ingest/routes.js";
import { pool } from "./db/pool.js";

const app = Fastify({ logger: false });

app.get("/healthz", async () => {
  await pool.query("SELECT 1");
  return { status: "ok" };
});

await registerIngestRoutes(app);

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
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
