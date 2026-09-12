import { pool } from "../../db/pool.js";
import { config } from "../../shared/config.js";
import { log } from "../../shared/telemetry.js";
import { backoffMs, sleep } from "../bus/retry.js";
import type { EventBus, BusMessage } from "../bus/types.js";
import type { StepContext, WorkflowDefinition } from "./types.js";

class StepTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError(`step timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface ExecutionRow {
  id: string;
  tenant_id: string;
  definition: string;
  correlation_id: string;
  status: string;
  current_step: number;
  context: Record<string, unknown>;
}

interface StepExecRow {
  step_index: number;
  step_name: string;
  direction: "forward" | "compensate";
  status: string;
}

/**
 * The workflow engine. Owns everything the plan's "done when" demands:
 * durable state (nothing lives only in memory), per-step timeout and
 * retry, and crash-resume via a lease (`locked_until`) rather than an
 * in-memory registry — a restarted process claims exactly the executions
 * whose lease has lapsed, with no separate "recovery scan" required.
 *
 * Orchestration, not choreography (see ADR): this engine is the single
 * place that knows step order and compensation order, which is what makes
 * "what has this execution actually done so far" answerable from one
 * table (`step_executions`) instead of reconstructed from scattered
 * per-service state.
 */
export class WorkflowEngine {
  private readonly instanceId = `workflow-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private stopped = false;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly bus: EventBus) {}

  register(definition: WorkflowDefinition): void {
    this.definitions.set(definition.name, definition);
    this.bus.subscribe("domain.events", `workflow-trigger:${definition.name}`, (message) =>
      this.handleTrigger(definition, message),
    );
  }

  start(): void {
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopPromise) await this.loopPromise;
  }

  private async handleTrigger(definition: WorkflowDefinition, message: BusMessage): Promise<void> {
    if (message.type !== definition.triggerEventType) return;

    // Idempotent: a redelivered trigger (at-least-once bus) must not start
    // a second execution. Enforced by the DB unique index, not by this
    // check — this is belt-and-suspenders logging, the constraint is the
    // actual guarantee.
    await pool.query(
      `INSERT INTO workflow_executions (tenant_id, definition, correlation_id, trigger_event_seq, context)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (definition, trigger_event_seq) WHERE trigger_event_seq IS NOT NULL DO NOTHING`,
      [message.tenantId, definition.name, message.correlationId, message.seq, JSON.stringify({ trigger: message.payload })],
    );
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let claimedAny = false;
      try {
        claimedAny = await this.tick();
      } catch (err: any) {
        log("error", "workflow engine tick failed", { err: err.message });
      }
      if (!this.stopped) {
        await sleep(claimedAny ? 0 : config.consumer.pollIntervalMs);
      }
    }
  }

  private async tick(): Promise<boolean> {
    const leaseUntil = new Date(Date.now() + config.consumer.leaseMs).toISOString();

    const { rows } = await pool.query<ExecutionRow>(
      `UPDATE workflow_executions
       SET locked_by = $1, locked_until = $2
       WHERE id IN (
         SELECT id FROM workflow_executions
         WHERE status IN ('running', 'compensating') AND (locked_until IS NULL OR locked_until < now())
         ORDER BY updated_at
         LIMIT 10
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, definition, correlation_id, status, current_step, context`,
      [this.instanceId, leaseUntil],
    );

    if (rows.length === 0) return false;

    for (const row of rows) {
      await this.processExecution(row).catch((err) =>
        log("error", "processExecution failed", { executionId: row.id, err: err.message }),
      );
    }
    return true;
  }

  private async processExecution(row: ExecutionRow): Promise<void> {
    const definition = this.definitions.get(row.definition);
    if (!definition) {
      log("error", "unknown workflow definition, skipping", { executionId: row.id, definition: row.definition });
      return;
    }

    if (row.status === "running") {
      await this.advanceForward(row, definition);
    } else if (row.status === "compensating") {
      await this.advanceCompensation(row, definition);
    }
  }

  private async advanceForward(row: ExecutionRow, definition: WorkflowDefinition): Promise<void> {
    if (row.current_step >= definition.steps.length) {
      await pool.query(
        `UPDATE workflow_executions SET status = 'completed', locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [row.id],
      );
      return;
    }

    const step = definition.steps[row.current_step];
    const ctx: StepContext = {
      executionId: row.id,
      tenantId: row.tenant_id,
      correlationId: row.correlation_id,
      context: row.context,
    };

    const { rows: attemptRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM step_executions WHERE execution_id = $1 AND step_index = $2 AND direction = 'forward'`,
      [row.id, row.current_step],
    );
    const attemptNumber = Number(attemptRows[0].count) + 1;

    const stepExecId = (
      await pool.query<{ id: string }>(
        `INSERT INTO step_executions (execution_id, step_index, step_name, direction, status, attempts)
         VALUES ($1, $2, $3, 'forward', 'running', $4) RETURNING id`,
        [row.id, row.current_step, step.name, attemptNumber],
      )
    ).rows[0].id;

    try {
      const result = await withTimeout(step.execute(ctx), step.timeoutMs);
      await pool.query(`UPDATE step_executions SET status = 'succeeded', finished_at = now() WHERE id = $1`, [stepExecId]);

      const newContext = { ...row.context, [step.name]: result ?? {} };
      await pool.query(
        // Clear `error` on a successful step: it must never linger from an
        // earlier retry once that retry has actually succeeded — a
        // `completed` execution showing a stale error message would be a
        // dashboard-misleading bug. (A `compensating`/`compensated` outcome
        // deliberately keeps its error — that's the reason compensation
        // happened, which is worth preserving as an audit trail.)
        `UPDATE workflow_executions
         SET current_step = current_step + 1, context = $2, error = NULL, locked_by = NULL, locked_until = NULL, updated_at = now()
         WHERE id = $1`,
        [row.id, JSON.stringify(newContext)],
      );
    } catch (err: any) {
      await pool.query(`UPDATE step_executions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
        stepExecId,
        err.message,
      ]);

      if (attemptNumber >= step.maxAttempts) {
        log("warn", "step exhausted retries, starting compensation", {
          executionId: row.id,
          step: step.name,
          attempts: attemptNumber,
        });
        await pool.query(
          `UPDATE workflow_executions
           SET status = 'compensating', error = $2, locked_by = NULL, locked_until = NULL, updated_at = now()
           WHERE id = $1`,
          [row.id, err.message],
        );
      } else {
        const delay = backoffMs(attemptNumber);
        log("warn", "step failed, will retry", { executionId: row.id, step: step.name, attempt: attemptNumber, delayMs: delay, err: err.message });
        await pool.query(
          `UPDATE workflow_executions
           SET locked_by = NULL, locked_until = now() + ($2 || ' milliseconds')::interval, error = $3, updated_at = now()
           WHERE id = $1`,
          [row.id, delay, err.message],
        );
      }
    }
  }

  private async advanceCompensation(row: ExecutionRow, definition: WorkflowDefinition): Promise<void> {
    const { rows: stepExecs } = await pool.query<StepExecRow>(
      `SELECT step_index, step_name, direction, status FROM step_executions WHERE execution_id = $1`,
      [row.id],
    );

    const succeededForward = new Set(
      stepExecs.filter((s) => s.direction === "forward" && s.status === "succeeded").map((s) => s.step_index),
    );
    const compensateSucceeded = new Set(
      stepExecs.filter((s) => s.direction === "compensate" && s.status === "succeeded").map((s) => s.step_index),
    );
    const compensateAttempts = new Map<number, number>();
    for (const s of stepExecs) {
      if (s.direction === "compensate") compensateAttempts.set(s.step_index, (compensateAttempts.get(s.step_index) ?? 0) + 1);
    }

    let anyGivenUp = false;
    let candidateIndex = -1;
    for (const idx of [...succeededForward].sort((a, b) => b - a)) {
      if (compensateSucceeded.has(idx)) continue;
      const step = definition.steps[idx];
      const attempts = compensateAttempts.get(idx) ?? 0;
      if (attempts >= step.maxAttempts) {
        anyGivenUp = true;
        continue;
      }
      candidateIndex = idx;
      break;
    }

    if (candidateIndex === -1) {
      const finalStatus = anyGivenUp ? "failed" : "compensated";
      await pool.query(
        `UPDATE workflow_executions SET status = $2, locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [row.id, finalStatus],
      );
      log(anyGivenUp ? "error" : "info", "compensation finished", { executionId: row.id, finalStatus });
      return;
    }

    const step = definition.steps[candidateIndex];
    const ctx: StepContext = {
      executionId: row.id,
      tenantId: row.tenant_id,
      correlationId: row.correlation_id,
      context: row.context,
    };
    const attemptNumber = (compensateAttempts.get(candidateIndex) ?? 0) + 1;

    const stepExecId = (
      await pool.query<{ id: string }>(
        `INSERT INTO step_executions (execution_id, step_index, step_name, direction, status, attempts)
         VALUES ($1, $2, $3, 'compensate', 'running', $4) RETURNING id`,
        [row.id, candidateIndex, step.name, attemptNumber],
      )
    ).rows[0].id;

    try {
      await withTimeout(step.compensate(ctx), step.timeoutMs);
      await pool.query(`UPDATE step_executions SET status = 'succeeded', finished_at = now() WHERE id = $1`, [stepExecId]);
      await pool.query(`UPDATE workflow_executions SET locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`, [
        row.id,
      ]);
    } catch (err: any) {
      await pool.query(`UPDATE step_executions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
        stepExecId,
        err.message,
      ]);

      if (attemptNumber >= step.maxAttempts) {
        await pool.query(
          `INSERT INTO dead_letters (source, execution_id, attempts, last_error, context)
           VALUES ($1, $2, $3, $4, $5)`,
          [`workflow:${definition.name}`, row.id, attemptNumber, err.message, { step: step.name, direction: "compensate" }],
        );
        log("error", "compensation step exhausted retries, dead-lettered", {
          executionId: row.id,
          step: step.name,
          attempts: attemptNumber,
        });
      }
      await pool.query(`UPDATE workflow_executions SET locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`, [
        row.id,
      ]);
    }
  }
}
