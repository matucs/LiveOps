import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { withTransaction } from "../../db/pool.js";
import { withSpan, currentTraceContext } from "../../shared/telemetry.js";
import { eventsIngestedTotal } from "../metrics/registry.js";
import type { EventEnvelope } from "./schema.js";

export interface IngestResult {
  eventSeq: string;
  eventId: string;
  correlationId: string;
  wasDuplicate: boolean;
}

/**
 * Ingests one event for a tenant. Business row + outbox row are written in
 * the SAME transaction (transactional outbox — see ADR on the pattern):
 * either both are durable or neither is, so a crash between "write event"
 * and "write outbox" is impossible by construction.
 *
 * Idempotency: (tenant_id, event_id) is UNIQUE at the database level. On a
 * conflict we do not error — we look up and return the original event, so
 * calling this endpoint N times with the same eventId has the same effect
 * as calling it once. See ADR-idempotency.
 */
export async function ingestEvent(tenantId: string, envelope: EventEnvelope): Promise<IngestResult> {
  return withSpan("ingest.event", { tenantId, eventType: envelope.type }, async () => {
    return withTransaction(async (client: PoolClient) => {
      const occurredAt = envelope.occurredAt ?? new Date().toISOString();
      const correlationId = envelope.correlationId ?? envelope.eventId;
      // Captured here (inside withSpan's active context) and persisted on
      // the row, so a consumer/workflow step running later — a different
      // async loop, possibly after a restart — can still link its own
      // spans back to this same trace. See withLinkedSpan.
      const { traceId, spanId } = currentTraceContext();

      const insert = await client.query<{ seq: string }>(
        `INSERT INTO events (event_id, tenant_id, type, correlation_id, causation_id, payload, occurred_at, trace_id, trace_span_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT ON CONSTRAINT uq_events_tenant_event DO NOTHING
         RETURNING seq`,
        [envelope.eventId, tenantId, envelope.type, correlationId, envelope.causationId ?? null, envelope.payload, occurredAt, traceId ?? null, spanId ?? null],
      );

      if (insert.rows.length === 0) {
        // Duplicate: the row already existed. Fetch it so the caller gets a
        // stable, identical response instead of an error.
        const existing = await client.query<{ seq: string }>(
          `SELECT seq FROM events WHERE tenant_id = $1 AND event_id = $2`,
          [tenantId, envelope.eventId],
        );
        return {
          eventSeq: existing.rows[0].seq,
          eventId: envelope.eventId,
          correlationId,
          wasDuplicate: true,
        };
      }

      const eventSeq = insert.rows[0].seq;

      // Same transaction: the outbox row for the domain-events topic.
      await client.query(
        `INSERT INTO outbox (event_seq, topic) VALUES ($1, $2)`,
        [eventSeq, "domain.events"],
      );

      eventsIngestedTotal.inc({ tenantId });
      return { eventSeq, eventId: envelope.eventId, correlationId, wasDuplicate: false };
    });
  });
}

export function newCorrelationId(): string {
  return randomUUID();
}
