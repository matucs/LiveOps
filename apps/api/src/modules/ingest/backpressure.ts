import { pool } from "../../db/pool.js";
import { log } from "../../shared/telemetry.js";

/**
 * Backpressure for ingest: if the outbox backlog grows past a threshold,
 * new events are rejected (503 + Retry-After) instead of accepted onto
 * an already-overwhelmed pipeline. Without this, ingest and the async
 * pipeline are decoupled in exactly the way that lets a slow consumer
 * turn into unbounded queue growth — fine on a laptop with disk to
 * spare, a real risk on the production VM's small Postgres volume
 * (ADR-009).
 *
 * The backlog count is refreshed by a background poll, not queried
 * per-request: `outbox` has an index on `(status, locked_until) WHERE
 * status = 'pending'` (idx_outbox_pending) so the count itself is cheap,
 * but adding a synchronous DB round trip to the hot ingest path for a
 * number that only needs to be approximately fresh is the wrong
 * trade-off — this is a shed decision, not a strict guarantee.
 */
export class BackpressureMonitor {
  private backlogCount = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly thresholdCount: number) {}

  start(intervalMs = 2000): void {
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbox WHERE status = 'pending'`);
    const next = Number(rows[0]?.count ?? 0);
    if (next >= this.thresholdCount && this.backlogCount < this.thresholdCount) {
      log("error", "backpressure engaged: outbox backlog over threshold", { backlog: next, threshold: this.thresholdCount });
    } else if (next < this.thresholdCount && this.backlogCount >= this.thresholdCount) {
      log("info", "backpressure released: outbox backlog back under threshold", { backlog: next, threshold: this.thresholdCount });
    }
    this.backlogCount = next;
  }

  isOverloaded(): boolean {
    return this.backlogCount >= this.thresholdCount;
  }

  snapshot() {
    return { backlogCount: this.backlogCount, thresholdCount: this.thresholdCount, overloaded: this.isOverloaded() };
  }
}
