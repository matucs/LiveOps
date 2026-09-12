export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Toggles whether this process runs background workers (outbox publisher,
  // event bus consumers). Modular monolith, split by config not by code: the
  // same binary can run as "API only" or "API + workers" or, later, as a
  // separate worker process entirely, with zero changes to the modules
  // themselves. See ADR on service extraction strategy.
  runWorkers: process.env.RUN_WORKERS !== "false",
  outbox: {
    pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 250),
    batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
  },
  consumer: {
    pollIntervalMs: Number(process.env.CONSUMER_POLL_INTERVAL_MS ?? 250),
    batchSize: Number(process.env.CONSUMER_BATCH_SIZE ?? 25),
    leaseMs: Number(process.env.CONSUMER_LEASE_MS ?? 10_000),
    maxAttempts: Number(process.env.CONSUMER_MAX_ATTEMPTS ?? 5),
  },
};
