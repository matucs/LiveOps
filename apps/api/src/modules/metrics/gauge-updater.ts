import { pool } from "../../db/pool.js";
import { consumerLag, deadLettersOpen } from "./registry.js";

/**
 * Refreshes the two gauges that aren't naturally updated at the point of
 * an event (unlike counters, incremented exactly where the thing they
 * count happens) — lag and open-dead-letter count are properties of
 * current state, so they're periodically recomputed instead.
 */
export class GaugeUpdater {
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs = 5000): void {
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const [{ rows: maxSeqRows }, { rows: checkpointRows }, { rows: dlqRows }] = await Promise.all([
      pool.query<{ max_seq: string | null }>("SELECT max(seq)::text AS max_seq FROM events"),
      pool.query<{ handler: string; last_seq: string }>("SELECT handler, last_seq FROM consumer_checkpoints"),
      pool.query<{ count: string }>("SELECT count(*)::text AS count FROM dead_letters WHERE replayed_at IS NULL"),
    ]);

    const maxSeq = Number(maxSeqRows[0]?.max_seq ?? 0);
    for (const row of checkpointRows) {
      consumerLag.set({ group: row.handler }, Math.max(0, maxSeq - Number(row.last_seq)));
    }
    deadLettersOpen.set(Number(dlqRows[0]?.count ?? 0));
  }
}
