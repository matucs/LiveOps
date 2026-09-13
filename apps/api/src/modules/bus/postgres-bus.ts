import { pool } from "../../db/pool.js";
import { config } from "../../shared/config.js";
import { log, withLinkedSpan } from "../../shared/telemetry.js";
import { backoffMs, sleep } from "./retry.js";
import type { BusMessage, EventBus, Handler } from "./types.js";

interface Subscription {
  topic: string;
  group: string;
  handler: Handler;
}

/**
 * Postgres implementation of `EventBus`. A consumer "group" is a row in
 * `consumer_checkpoints` keyed by handler name — each group independently
 * tracks how far into the (topic-filtered) event log it has advanced,
 * exactly like a Kafka consumer group's committed offset. Multiple groups
 * subscribed to the same topic each see every message, once.
 *
 * Poison-message handling: a message that exhausts `maxAttempts` is written
 * to `dead_letters` and the checkpoint advances past it anyway — one bad
 * message must never permanently block a group. Attempt counting is
 * in-memory and per-poll-cycle (not persisted): if the process crashes
 * mid-retry, the message is simply retried from attempt 0 after restart,
 * which is safe precisely because every handler is required to be
 * idempotent (see ADR on idempotency).
 */
export class PostgresEventBus implements EventBus {
  private subscriptions: Subscription[] = [];
  private stopped = false;
  private loops: Promise<void>[] = [];

  subscribe(topic: string, group: string, handler: Handler): void {
    this.subscriptions.push({ topic, group, handler });
  }

  start(): void {
    this.stopped = false;
    this.loops = this.subscriptions.map((sub) => this.runLoop(sub));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loops);
  }

  private async runLoop(sub: Subscription): Promise<void> {
    while (!this.stopped) {
      let processedAny = false;
      try {
        processedAny = await this.pollOnce(sub);
      } catch (err: any) {
        log("error", "consumer poll failed", { group: sub.group, err: err.message });
      }
      if (!this.stopped) {
        await sleep(processedAny ? 0 : config.consumer.pollIntervalMs);
      }
    }
  }

  /** Returns true if at least one message was processed (success or dead-lettered). */
  private async pollOnce(sub: Subscription): Promise<boolean> {
    await pool.query(
      `INSERT INTO consumer_checkpoints (handler, last_seq) VALUES ($1, 0)
       ON CONFLICT (handler) DO NOTHING`,
      [sub.group],
    );

    const { rows: cpRows } = await pool.query<{ last_seq: string }>(
      `SELECT last_seq FROM consumer_checkpoints WHERE handler = $1`,
      [sub.group],
    );
    const lastSeq = cpRows[0]?.last_seq ?? "0";

    const { rows: messages } = await pool.query<{
      seq: string;
      event_id: string;
      tenant_id: string;
      type: string;
      correlation_id: string;
      causation_id: string | null;
      payload: Record<string, unknown>;
      occurred_at: string;
      trace_id: string | null;
      trace_span_id: string | null;
    }>(
      `SELECT e.seq, e.event_id, e.tenant_id, e.type, e.correlation_id, e.causation_id, e.payload, e.occurred_at, e.trace_id, e.trace_span_id
       FROM events e
       JOIN outbox o ON o.event_seq = e.seq
       WHERE o.topic = $1 AND o.status = 'dispatched' AND e.seq > $2
       ORDER BY e.seq
       LIMIT $3`,
      [sub.topic, lastSeq, config.consumer.batchSize],
    );

    if (messages.length === 0) return false;

    for (const row of messages) {
      const message: BusMessage = {
        seq: row.seq,
        eventId: row.event_id,
        tenantId: row.tenant_id,
        type: row.type,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        payload: row.payload,
        occurredAt: row.occurred_at,
        traceId: row.trace_id,
        traceSpanId: row.trace_span_id,
      };

      await this.deliverWithRetry(sub, message);

      // Advance the checkpoint after each message (not just at batch end) so
      // a crash mid-batch loses at most in-flight progress, never re-derives
      // it incorrectly — the next poll resumes exactly after this message.
      await pool.query(
        `UPDATE consumer_checkpoints SET last_seq = $1, updated_at = now() WHERE handler = $2`,
        [message.seq, sub.group],
      );
    }

    return true;
  }

  private async deliverWithRetry(sub: Subscription, message: BusMessage): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await withLinkedSpan(
          { traceId: message.traceId, spanId: message.traceSpanId },
          `bus.deliver ${sub.group}`,
          { group: sub.group, eventId: message.eventId, eventType: message.type, attempt },
          () => sub.handler(message),
        );
        return;
      } catch (err: any) {
        attempt += 1;
        if (attempt >= config.consumer.maxAttempts) {
          await this.deadLetter(sub, message, attempt, err.message);
          return;
        }
        const delay = backoffMs(attempt);
        log("warn", "handler failed, retrying", {
          group: sub.group,
          eventId: message.eventId,
          attempt,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
      }
    }
  }

  private async deadLetter(sub: Subscription, message: BusMessage, attempts: number, lastError: string): Promise<void> {
    await pool.query(
      `INSERT INTO dead_letters (source, event_seq, attempts, last_error, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [`consumer:${sub.group}`, message.seq, attempts, lastError, { eventId: message.eventId, type: message.type }],
    );
    log("error", "message dead-lettered", { group: sub.group, eventId: message.eventId, attempts, lastError });
  }
}
