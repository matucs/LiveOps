import { pool } from "../../../db/pool.js";
import { config } from "../../../shared/config.js";
import { log, withSpan } from "../../../shared/telemetry.js";
import { kafka } from "./client.js";

/**
 * The Kafka-backed half of the transactional outbox (ADR-003, ADR-013).
 * The pattern is identical to the Postgres publisher — claim pending
 * rows with `FOR UPDATE SKIP LOCKED`, mark them dispatched — the only
 * thing that changes is what "dispatched" actually means: instead of a
 * status flip that makes the row visible to a polling SELECT, dispatched
 * here means Kafka has acknowledged the produce. A produce failure
 * leaves the row `pending`; the lease expires and the next tick retries
 * it, exactly like the Postgres publisher's crash-recovery story
 * (verified live in Phase 02) — this is the same guarantee, not a new one.
 *
 * Partition key: tenantId. Every event for one tenant lands on the same
 * partition, so per-tenant ordering is preserved (a real requirement —
 * e.g. an order's create/update events must be seen in order); different
 * tenants can be spread across partitions for parallelism. Documented
 * here because it's a genuine trade-off (ADR-013), not a default nobody
 * decided.
 */
export class KafkaOutboxPublisher {
  private readonly producer = kafka.producer({ allowAutoTopicCreation: true });
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connected = false;

  async start(): Promise<void> {
    await this.producer.connect();
    this.connected = true;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.connected) await this.producer.disconnect();
  }

  private scheduleNext(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => log("error", "kafka outbox publisher tick failed", { err: err.message }))
        .finally(() => this.scheduleNext(config.outbox.pollIntervalMs));
    }, delayMs);
  }

  private async tick(): Promise<void> {
    const client = await pool.connect();
    let claimed: any[];
    try {
      await client.query("BEGIN");
      const leaseUntil = new Date(Date.now() + config.outbox.pollIntervalMs * 4).toISOString();

      const result = await client.query(
        `UPDATE outbox
         SET locked_by = $1, locked_until = $2
         WHERE id IN (
           SELECT o.id FROM outbox o
           WHERE o.status = 'pending' AND (o.locked_until IS NULL OR o.locked_until < now())
           ORDER BY o.id
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, event_seq, topic`,
        ["kafka-outbox", leaseUntil, config.outbox.batchSize],
      );
      await client.query("COMMIT");
      claimed = result.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (claimed.length === 0) return;

    await withSpan("outbox.dispatch_batch_kafka", { count: claimed.length }, async () => {
      const seqs = claimed.map((r) => r.event_seq);
      const { rows: events } = await pool.query(
        `SELECT seq, event_id, tenant_id, type, correlation_id, causation_id, payload, occurred_at, trace_id, trace_span_id
         FROM events WHERE seq = ANY($1::bigint[])`,
        [seqs],
      );
      const eventBySeq = new Map(events.map((e) => [e.seq, e]));

      const byTopic = new Map<string, typeof claimed>();
      for (const row of claimed) {
        if (!byTopic.has(row.topic)) byTopic.set(row.topic, []);
        byTopic.get(row.topic)!.push(row);
      }

      const dispatchedIds: string[] = [];
      for (const [topic, rows] of byTopic) {
        // Built alongside `messages`, not derived from `rows` afterward:
        // a row whose event failed to join must NOT be marked dispatched
        // just because other rows in the same batch were. The previous
        // version pushed every row's id from `rows` regardless of which
        // ones actually produced a message — found by a real discrepancy
        // during the V2 load test (see docs/phase-10-notes.md): Kafka's
        // own consumer-group lag read 0 while the outbox table showed
        // every row 'dispatched', yet the dashboard's shadow checkpoint
        // sat 22 events short of the true event log position. The 22
        // outbox rows had been marked dispatched without ever producing
        // a Kafka message.
        const idsToMark: string[] = [];
        const messages: { key: string; value: string }[] = [];
        for (const row of rows) {
          const e = eventBySeq.get(row.event_seq);
          if (!e) {
            log("error", "outbox row has no matching event row — leaving pending for retry", {
              outboxId: row.id,
              eventSeq: row.event_seq,
            });
            continue;
          }
          messages.push({
            key: e.tenant_id, // partition affinity: one tenant's events stay in order
            value: JSON.stringify({
              seq: e.seq,
              eventId: e.event_id,
              tenantId: e.tenant_id,
              type: e.type,
              correlationId: e.correlation_id,
              causationId: e.causation_id,
              payload: e.payload,
              occurredAt: e.occurred_at,
              traceId: e.trace_id,
              traceSpanId: e.trace_span_id,
            }),
          });
          idsToMark.push(row.id);
        }

        if (messages.length === 0) continue;

        // kafkajs's send() resolves with one RecordMetadata entry per
        // PARTITION actually written to (not per message) — a resolved
        // promise alone doesn't distinguish "every partition acked" from
        // "some partition in this batch reported an error but the client
        // didn't throw." Checking errorCode explicitly is what catches
        // that gap. Added after a real discrepancy in the V2 load test:
        // Kafka's own consumer-group lag read 0 while the outbox showed
        // every row 'dispatched', 22 events short of ever having reached
        // a message a consumer could read (docs/phase-10-notes.md) — root
        // cause not pinned down with certainty, but this is the correct
        // defense regardless of the exact mechanism.
        // acks: -1 (all in-sync replicas) made explicit rather than left
        // to kafkajs's default — a produce this code treats as durable
        // enough to mark the outbox row dispatched should not depend on
        // an unstated default remaining what it is today.
        const results = await this.producer.send({ topic, messages, acks: -1 });
        const failed = results.filter((r) => r.errorCode && r.errorCode !== 0);
        if (failed.length > 0) {
          log("error", "kafka produce reported a partition error, leaving rows pending for retry", {
            topic,
            failed,
          });
          continue; // idsToMark for this topic group is NOT added to dispatchedIds — rows stay pending, lease expires, next tick retries
        }

        dispatchedIds.push(...idsToMark);
      }

      if (dispatchedIds.length > 0) {
        await pool.query(
          `UPDATE outbox SET status = 'dispatched', dispatched_at = now(), attempts = attempts + 1 WHERE id = ANY($1::bigint[])`,
          [dispatchedIds],
        );
      }

      log("info", "outbox batch dispatched to kafka", { count: dispatchedIds.length });
    });
  }
}
