export const config = {
  port: Number(process.env.PORT ?? 3000),
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
