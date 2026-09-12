import pg from "pg";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  `postgres://${process.env.POSTGRES_USER ?? "liveops"}:${process.env.POSTGRES_PASSWORD ?? "liveops_dev_password"}@${
    process.env.POSTGRES_HOST ?? "localhost"
  }:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "liveops"}`;

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  // A background/idle client crashing must never crash the process —
  // it will be reconnected on next use. Log and move on.
  console.error(JSON.stringify({ level: "error", msg: "pg pool idle client error", err: err.message }));
});

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back
 * and rethrows on any error. This is the only way write paths that need
 * atomicity (business row + outbox row) should touch the database.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
