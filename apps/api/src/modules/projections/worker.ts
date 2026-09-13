import { pool } from "../../db/pool.js";
import { config } from "../../shared/config.js";
import { log } from "../../shared/telemetry.js";
import { sleep } from "../bus/retry.js";
import { workflowDefinitions } from "../workflow/registry.js";

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

    for (const e of events) {
      await this.projectEvent(e);
      await pool.query(`UPDATE consumer_checkpoints SET last_seq = $1, updated_at = now() WHERE handler = $2`, [
        e.seq,
        ProjectionWorker.GROUP,
      ]);
    }

    // Workflow executions change via a SEPARATE consumer group
    // (workflow-trigger) and the engine's own tick, both of which run
    // independently of this loop and typically a little later than the
    // triggering event itself. Refreshing this projection only when
    // `events.length > 0` (the original version of this code) missed
    // exactly that: a single quiet event's workflow could finish its
    // steps *after* this tick had already returned early, with no further
    // raw events ever arriving to trigger another refresh — a workflow
    // could sit completed forever without ever appearing in the
    // dashboard. Found live during the first production deployment.
    // Refreshing unconditionally, every tick, is the actual fix; it's
    // cheap (one bulk statement, Phase 06) regardless of backlog size.
    await this.refreshWorkflowProjection();

    return events.length > 0;
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
   *
   * Bulk upsert, not one query per row: the first version of this method
   * looped over changed executions and issued one INSERT...ON CONFLICT per
   * row. That was invisible at demo scale and became the dominant cost
   * under Phase 06's load test — with ~3,000+ workflow_executions rows
   * touched in the lookback window, this ran ~3,000 sequential round trips
   * on *every* tick, throttling every consumer sharing the connection pool.
   * Fixed by joining a small VALUES list (workflow definitions — bounded
   * by the number of distinct workflows, not the number of executions) so
   * the whole refresh is one statement. See docs/phase-06-notes.md for the
   * before/after numbers.
   */
  private async refreshWorkflowProjection(): Promise<void> {
    if (workflowDefinitions.length === 0) return;

    const stepCountValues = workflowDefinitions.map((d, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::int)`).join(", ");
    const stepCountParams = workflowDefinitions.flatMap((d) => [d.name, d.steps.length]);

    await pool.query(
      `WITH step_counts(definition, step_count) AS (VALUES ${stepCountValues})
       INSERT INTO projection_workflow_summary
         (execution_id, tenant_id, definition, status, current_step, step_count, correlation_id, error, updated_at)
       SELECT we.id, we.tenant_id, we.definition, we.status, we.current_step, sc.step_count,
              we.correlation_id, we.error, we.updated_at
       FROM workflow_executions we
       JOIN step_counts sc ON sc.definition = we.definition
       WHERE we.updated_at > now() - interval '1 hour'
       ON CONFLICT (execution_id) DO UPDATE SET
         status = EXCLUDED.status,
         current_step = EXCLUDED.current_step,
         step_count = EXCLUDED.step_count,
         error = EXCLUDED.error,
         updated_at = EXCLUDED.updated_at`,
      stepCountParams,
    );
  }
}
