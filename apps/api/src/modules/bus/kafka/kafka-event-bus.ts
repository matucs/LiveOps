import { pool } from "../../../db/pool.js";
import { config } from "../../../shared/config.js";
import { log, withLinkedSpan } from "../../../shared/telemetry.js";
import { backoffMs, sleep } from "../retry.js";
import { kafka } from "./client.js";
import type { BusMessage, EventBus, Handler } from "../types.js";

interface Subscription {
  topic: string;
  group: string;
  handler: Handler;
}

/**
 * Kafka-backed implementation of the same `EventBus` interface
 * `PostgresEventBus` implements (ADR-002, ADR-013) — this is the actual
 * point of that interface existing: every caller (audit-log,
 * workflow-trigger, projection-worker, dead-letter replay) is unchanged.
 *
 * Consumer group semantics are now Kafka's own, not hand-rolled: each
 * `group` here is a real Kafka consumer group with its own committed
 * offset, managed by the broker. `consumer_checkpoints` is still updated
 * after each message purely as a **shadow** value for the dashboard's
 * lag gauge and the existing metrics/observability code, which read that
 * table regardless of transport — it is not what governs delivery here,
 * Kafka's own offsets are. Documented explicitly so "why does this table
 * still get written when Kafka has its own offsets" has an answer.
 *
 * Poison-message handling matches the Postgres bus exactly: retry with
 * backoff in-memory, dead-letter after `maxAttempts`, then let the
 * consumer move on (Kafka commits the offset once `eachMessage`
 * returns) — one bad message never blocks a partition forever.
 */
export class KafkaEventBus implements EventBus {
  private subscriptions: Subscription[] = [];
  private consumers: Map<string, ReturnType<typeof kafka.consumer>> = new Map();
  private stopped = false;

  subscribe(topic: string, group: string, handler: Handler): void {
    this.subscriptions.push({ topic, group, handler });
  }

  getHandler(group: string): Handler | undefined {
    return this.subscriptions.find((s) => s.group === group)?.handler;
  }

  start(): void {
    this.stopped = false;
    for (const sub of this.subscriptions) {
      this.runConsumer(sub).catch((err) => log("error", "kafka consumer crashed", { group: sub.group, err: err.message }));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.consumers.values()].map((c) => c.disconnect()));
  }

  private async runConsumer(sub: Subscription): Promise<void> {
    // sessionTimeout/heartbeatInterval widened after a real finding
    // (docs/phase-10-notes.md): under a large backlog, `eachMessage`
    // does two sequential DB round trips per message (the handler, then
    // the shadow-checkpoint write below) with no explicit heartbeat in
    // between. At the default 10s session timeout, sustained processing
    // of a multi-thousand-message backlog risked the broker deciding
    // this consumer was dead and triggering a rebalance mid-catch-up —
    // not a correctness bug (every message's actual side effect still
    // completed, verified directly against audit_log/workflow_executions),
    // but it could leave this class's own shadow checkpoint under-reporting
    // the true position by however many messages were in flight at the
    // moment of rebalance.
    const consumer = kafka.consumer({ groupId: sub.group, sessionTimeout: 45_000, heartbeatInterval: 3_000 });
    this.consumers.set(sub.group, consumer);

    await consumer.connect();
    await consumer.subscribe({ topic: sub.topic, fromBeginning: true });

    await pool.query(
      `INSERT INTO consumer_checkpoints (handler, last_seq) VALUES ($1, 0) ON CONFLICT (handler) DO NOTHING`,
      [sub.group],
    );

    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const parsed = JSON.parse(message.value.toString());
        const busMessage: BusMessage = {
          seq: String(parsed.seq),
          eventId: parsed.eventId,
          tenantId: parsed.tenantId,
          type: parsed.type,
          correlationId: parsed.correlationId,
          causationId: parsed.causationId,
          payload: parsed.payload,
          occurredAt: parsed.occurredAt,
          traceId: parsed.traceId,
          traceSpanId: parsed.traceSpanId,
        };

        await this.deliverWithRetry(sub, busMessage);

        // Shadow checkpoint for the dashboard/metrics — see class doc.
        await pool.query(`UPDATE consumer_checkpoints SET last_seq = $1, updated_at = now() WHERE handler = $2`, [
          busMessage.seq,
          sub.group,
        ]);
      },
    });
  }

  private async deliverWithRetry(sub: Subscription, message: BusMessage): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await withLinkedSpan(
          { traceId: message.traceId, spanId: message.traceSpanId },
          `bus.deliver ${sub.group}`,
          { group: sub.group, eventId: message.eventId, eventType: message.type, attempt, transport: "kafka" },
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
        log("warn", "handler failed, retrying (kafka)", {
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
    log("error", "message dead-lettered (kafka)", { group: sub.group, eventId: message.eventId, attempts, lastError });
  }
}
