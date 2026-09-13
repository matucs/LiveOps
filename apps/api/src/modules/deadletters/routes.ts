import type { FastifyInstance } from "fastify";
import { requireTenant } from "../tenant/auth.js";
import { pool } from "../../db/pool.js";
import { log, withLinkedSpan } from "../../shared/telemetry.js";
import type { EventBus } from "../bus/types.js";

/**
 * Dead-letter replay — scoped honestly to consumer-sourced dead letters
 * (source = "consumer:<group>"), not workflow-compensation dead letters.
 * A consumer's poison message replays cleanly: re-invoke the exact same
 * idempotent handler against the exact same event, no state machine to
 * reconcile. A workflow compensation that gave up is a harder problem —
 * the execution has already reached a terminal `failed` status, and
 * "replay" would mean re-opening that state machine and re-deriving how
 * many attempts remain, which is a real feature this project doesn't
 * attempt to half-build. Replaying one of those returns 501, not a
 * silent no-op.
 */
export async function registerDeadLetterRoutes(app: FastifyInstance, eventBus: EventBus) {
  app.post<{ Params: { id: string } }>(
    "/api/v1/dead-letters/:id/replay",
    { preHandler: requireTenant },
    async (request, reply) => {
      const tenant = request.tenant!;

      const { rows } = await pool.query<{
        id: string;
        source: string;
        event_seq: string | null;
        replayed_at: string | null;
      }>(
        `SELECT dl.id, dl.source, dl.event_seq, dl.replayed_at
         FROM dead_letters dl
         LEFT JOIN events e ON e.seq = dl.event_seq
         LEFT JOIN workflow_executions we ON we.id = dl.execution_id
         WHERE dl.id = $1 AND COALESCE(e.tenant_id, we.tenant_id) = $2`,
        [request.params.id, tenant.tenantId],
      );

      const dl = rows[0];
      if (!dl) return reply.code(404).send({ error: "not_found" });
      if (dl.replayed_at) return reply.code(409).send({ error: "already_replayed" });

      if (!dl.source.startsWith("consumer:") || !dl.event_seq) {
        return reply.code(501).send({
          error: "not_replayable",
          message:
            "Only consumer-sourced dead letters can be replayed here. A workflow-compensation dead letter means the execution reached a terminal 'failed' state — replaying it safely requires reopening that state machine, which isn't implemented (see docs/adr/ADR-011 and the replay notes).",
        });
      }

      const group = dl.source.slice("consumer:".length);
      const handler = eventBus.getHandler?.(group);
      if (!handler) {
        return reply.code(500).send({ error: "handler_not_found", message: `No registered handler for group '${group}'.` });
      }

      const { rows: eventRows } = await pool.query(
        `SELECT seq, event_id, tenant_id, type, correlation_id, causation_id, payload, occurred_at, trace_id, trace_span_id
         FROM events WHERE seq = $1`,
        [dl.event_seq],
      );
      const e = eventRows[0];
      if (!e) return reply.code(404).send({ error: "event_not_found" });

      try {
        await withLinkedSpan({ traceId: e.trace_id, spanId: e.trace_span_id }, `dead-letter.replay ${group}`, { group, eventId: e.event_id }, () =>
          handler({
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
        );
      } catch (err: any) {
        log("error", "dead-letter replay failed", { deadLetterId: dl.id, group, err: err.message });
        return reply.code(502).send({ error: "replay_failed", message: err.message });
      }

      await pool.query(`UPDATE dead_letters SET replayed_at = now() WHERE id = $1`, [dl.id]);
      log("info", "dead-letter replayed", { deadLetterId: dl.id, group, eventId: e.event_id });
      return { replayed: true };
    },
  );
}
