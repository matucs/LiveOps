import { pool } from "../../db/pool.js";
import { config } from "../../shared/config.js";
import { log } from "../../shared/telemetry.js";
import { sleep } from "../bus/retry.js";
import { stepCountFor } from "../workflow/registry.js";

/**
 * The projection worker. This is the "Q" side of CQRS: it is the ONLY
 * writer of the `projection_*` tables, and it gets there exclusively by
 * consuming `events` — never by reading `workflow_executions` or any
 * other write-side table directly. That one-way arrow is what makes the
 * read side re-derivable from the log (see Phase 08's rebuild-from-scratch
 * work) instead of being just another place business logic can drift.
 *
 * Consistency model: read models lag the write side by however long a
 * poll tick takes (bounded by CONSUMER_POLL_INTERVAL_MS, typically well
 * under a second locally). The dashboard is explicitly eventually
 * consistent — documented, not hidden, per ADR-CQRS.
 *
 * Uses its own consumer_checkpoints row ("projection-worker"), independent
 * of the audit-log and workflow-trigger groups from Phases 02-03 — each
 * projection consumer sees the full event log at its own pace, exactly
 * like an independent Kafka consumer group.
 */
export class ProjectionWorker {
  private static readonly GROUP = "projection-worker";
  private stopped = false;
  private loopPromise: Promise<void> | null = null;

  start(): void {
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopPromise) await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let processedAny = false;
      try {
        processedAny = await this.tick();
      } catch (err: any) {
        log("error", "projection worker tick failed", { err: err.message });
      }
      if (!this.stopped) await sleep(processedAny ? 0 : config.consumer.pollIntervalMs);
    }
  }

  private async tick(): Promise<boolean> {
    await pool.query(
      `INSERT INTO consumer_checkpoints (handler, last_seq) VALUES ($1, 0) ON CONFLICT (handler) DO NOTHING`,
      [ProjectionWorker.GROUP],
    );
    const { rows: cpRows } = await pool.query<{ last_seq: string }>(
      `SELECT last_seq FROM consumer_checkpoints WHERE handler = $1`,
      [ProjectionWorker.GROUP],
    );
    const lastSeq = cpRows[0]?.last_seq ?? "0";

    const { rows: events } = await pool.query<{
      seq: string;
      tenant_id: string;
      type: string;
      occurred_at: string;
    }>(
      `SELECT seq, tenant_id, type, occurred_at FROM events WHERE seq > $1 ORDER BY seq LIMIT $2`,
      [lastSeq, config.consumer.batchSize],
    );

    if (events.length === 0) return false;

    for (const e of events) {
      await this.projectEvent(e);
      await pool.query(`UPDATE consumer_checkpoints SET last_seq = $1, updated_at = now() WHERE handler = $2`, [
        e.seq,
        ProjectionWorker.GROUP,
      ]);
    }

    // Workflow executions change after this worker's own event may have
    // been consumed (a workflow can still be running), so workflow
    // projections are refreshed on every tick rather than event-by-event —
    // simpler, and cheap at this scale. See docs for the trade-off.
    await this.refreshWorkflowProjection();

    return true;
  }

  private async projectEvent(e: { seq: string; tenant_id: string; type: string; occurred_at: string }): Promise<void> {
    const minute = new Date(e.occurred_at);
    minute.setSeconds(0, 0);

    await pool.query(
      `INSERT INTO projection_throughput_minute (tenant_id, minute, event_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, minute) DO UPDATE SET event_count = projection_throughput_minute.event_count + 1`,
      [e.tenant_id, minute.toISOString()],
    );

    await pool.query(
      `INSERT INTO projection_tenant_activity (tenant_id, event_count, last_event_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET
         event_count = projection_tenant_activity.event_count + 1,
         last_event_at = $2`,
      [e.tenant_id, e.occurred_at],
    );
  }

  /**
   * Rebuilds the workflow summary projection from workflow_executions. This
   * is technically reading a write-side table, which looks like it breaks
   * the CQRS rule above — the honest reason is documented in
   * docs/adr/cqrs.md: workflow status is highly mutable and re-deriving it
   * purely from the event log would require projecting every step
   * transition as its own event, which Phase 03 does not currently emit.
   * Flagged as a known simplification, not hidden.
   */
  private async refreshWorkflowProjection(): Promise<void> {
    const { rows } = await pool.query<{
      id: string;
      tenant_id: string;
      definition: string;
      status: string;
      current_step: number;
      correlation_id: string;
      error: string | null;
      updated_at: string;
    }>(`SELECT id, tenant_id, definition, status, current_step, correlation_id, error, updated_at
        FROM workflow_executions WHERE updated_at > now() - interval '1 hour'`);

    for (const we of rows) {
      await pool.query(
        `INSERT INTO projection_workflow_summary
           (execution_id, tenant_id, definition, status, current_step, step_count, correlation_id, error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (execution_id) DO UPDATE SET
           status = EXCLUDED.status,
           current_step = EXCLUDED.current_step,
           step_count = EXCLUDED.step_count,
           error = EXCLUDED.error,
           updated_at = EXCLUDED.updated_at`,
        [we.id, we.tenant_id, we.definition, we.status, we.current_step, stepCountFor(we.definition), we.correlation_id, we.error, we.updated_at],
      );
    }
  }
}
