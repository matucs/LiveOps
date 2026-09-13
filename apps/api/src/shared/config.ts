export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Toggles whether this process runs background workers (outbox publisher,
  // event bus consumers). Modular monolith, split by config not by code: the
  // same binary can run as "API only" or "API + workers" or, later, as a
  // separate worker process entirely, with zero changes to the modules
  // themselves. See ADR on service extraction strategy.
  runWorkers: process.env.RUN_WORKERS !== "false",
  webOrigins: (process.env.WEB_ORIGINS ?? "http://localhost:3001").split(",").map((s) => s.trim()),
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
  workflow: {
    // How many executions the engine claims per tick. Phase 06's load test
    // found this was hardcoded at 10 and was the dominant throughput limit
    // once the event-consumption side was fixed: a fixed claim size means
    // completion rate stays flat regardless of backlog size, producing the
    // "slow, then suddenly fast as the backlog shrinks" curve documented in
    // docs/phase-06-notes.md. Made configurable rather than just bumped —
    // the right value depends on step cost and DB capacity, which varies
    // by deployment.
    batchSize: Number(process.env.WORKFLOW_ENGINE_BATCH_SIZE ?? 50),
  },
  backpressure: {
    // Pending outbox rows before ingest starts shedding load (503). Set
    // high enough that normal bursts (see the load test's 100-concurrency
    // wave, Phase 06) never trip it, low enough to actually protect a
    // small Postgres volume from unbounded queue growth if a consumer
    // genuinely stalls.
    outboxThreshold: Number(process.env.BACKPRESSURE_OUTBOX_THRESHOLD ?? 20_000),
  },
};
