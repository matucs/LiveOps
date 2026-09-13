import { pool } from "../../db/pool.js";
import { config } from "../../shared/config.js";
import { log, withSpan } from "../../shared/telemetry.js";

/**
 * The outbox publisher. Its only job: move rows from `pending` to
 * `dispatched` in the outbox table, which is what makes them visible to
 * consumer groups. It runs independently of the HTTP request that wrote
 * the row (see the transactional outbox pattern in docs/adr) — so a crash
 * right after commit just means the row sits `pending` a little longer,
 * picked up on the next poll or by another instance.
 *
 * `FOR UPDATE SKIP LOCKED` lets multiple publisher instances run
 * concurrently without duplicating work: each claims a disjoint batch.
 * A `locked_until` lease (not a held transaction) means a publisher that
 * dies mid-batch releases its claim automatically once the lease expires,
 * rather than blocking the row forever.
 */
export class OutboxPublisher {
  private readonly instanceId = `outbox-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  start() {
    this.scheduleNext(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => log("error", "outbox publisher tick failed", { err: err.message }))
        .finally(() => this.scheduleNext(config.outbox.pollIntervalMs));
    }, delayMs);
  }

  private async tick() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const leaseUntil = new Date(Date.now() + config.outbox.pollIntervalMs * 4).toISOString();

      const claimed = await client.query<{ id: string }>(
        `UPDATE outbox
         SET locked_by = $1, locked_until = $2
         WHERE id IN (
           SELECT id FROM outbox
           WHERE status = 'pending' AND (locked_until IS NULL OR locked_until < now())
           ORDER BY id
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id`,
        [this.instanceId, leaseUntil, config.outbox.batchSize],
      );

      await client.query("COMMIT");

      if (claimed.rows.length === 0) return;

      const ids = claimed.rows.map((r) => r.id);
      // A batch mixes many events' independent traces, so this is its own
      // top-level span rather than linked to any one of them — see
      // bus.deliver (postgres-bus.ts) for where per-event trace linking
      // resumes, downstream of this batch-shaped step.
      await withSpan("outbox.dispatch_batch", { count: ids.length }, async () => {
        // "Publishing" in the V1 Postgres transport is the act of marking
        // the row dispatched — that transition is what consumer groups
        // poll for. A real Kafka publisher would produce() here instead,
        // and would only mark dispatched after the broker ack'd.
        await pool.query(
          `UPDATE outbox SET status = 'dispatched', dispatched_at = now(), attempts = attempts + 1
           WHERE id = ANY($1::bigint[])`,
          [ids],
        );
      });

      log("info", "outbox batch dispatched", { count: ids.length, instanceId: this.instanceId });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
