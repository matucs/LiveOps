import type { FastifyInstance } from "fastify";
import { resolveTenant } from "../tenant/auth.js";
import { pool } from "../../db/pool.js";
import { config } from "../../shared/config.js";

/**
 * Server-Sent Events for the dashboard. Chosen over WebSockets (see ADR):
 * updates only flow server->client here, so SSE gives us auto-reconnect
 * and plain HTTP for free, with no separate socket server to scale later.
 *
 * Implementation is a poll-and-diff against the projection tables, not a
 * push from the projection worker — simpler, and the tables are already
 * the cheap, indexed thing to poll. The interval matches the consumer
 * poll interval, so a client is never more stale than the projections
 * themselves already are.
 */
export async function registerDashboardStream(app: FastifyInstance) {
  // No `requireTenant` preHandler here: the browser's native EventSource
  // cannot set an Authorization header, so this one route deliberately
  // accepts the key as a `?token=` query param instead, resolved directly
  // via `resolveTenant`. Kept isolated to this route rather than folded
  // into `requireTenant` itself, because a key in a query string is more
  // likely to end up in a proxy or access log than one in a header — an
  // acceptable trade-off for a local demo, called out explicitly as a
  // "use a short-lived stream token in production" item, not silently
  // reused as a general auth path.
  app.get<{ Querystring: { token?: string } }>("/api/v1/dashboard/stream", async (request, reply) => {
    const rawKey = request.query.token ?? "";
    const tenant = rawKey ? await resolveTenant(rawKey) : null;
    if (!tenant) {
      reply.code(401).send({ error: "invalid_api_key", message: "Provide a valid API key as ?token=<key>" });
      return reply;
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    const send = (event: string, data: unknown) => {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    while (!closed) {
      try {
        const [activity, workflows, throughput, deadLetters] = await Promise.all([
          pool.query(`SELECT event_count, last_event_at FROM projection_tenant_activity WHERE tenant_id = $1`, [
            tenant.tenantId,
          ]),
          pool.query(
            `SELECT execution_id, definition, status, current_step, step_count, correlation_id, error, updated_at
             FROM projection_workflow_summary WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 20`,
            [tenant.tenantId],
          ),
          pool.query(
            `SELECT minute, event_count FROM projection_throughput_minute
             WHERE tenant_id = $1 AND minute > now() - interval '30 minutes' ORDER BY minute ASC`,
            [tenant.tenantId],
          ),
          pool.query(
            `SELECT count(*)::int AS count FROM dead_letters dl
             LEFT JOIN events e ON e.seq = dl.event_seq
             LEFT JOIN workflow_executions we ON we.id = dl.execution_id
             WHERE COALESCE(e.tenant_id, we.tenant_id) = $1 AND dl.replayed_at IS NULL`,
            [tenant.tenantId],
          ),
        ]);
        send("snapshot", {
          activity: activity.rows[0] ?? { event_count: 0, last_event_at: null },
          workflows: workflows.rows,
          throughput: throughput.rows,
          openDeadLetters: deadLetters.rows[0]?.count ?? 0,
        });
      } catch (err: any) {
        send("error", { message: err.message });
      }
      await new Promise((r) => setTimeout(r, config.consumer.pollIntervalMs));
    }
  });
}
