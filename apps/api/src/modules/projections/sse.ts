import type { FastifyInstance } from "fastify";
import { requireTenant } from "../tenant/auth.js";
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
  app.get("/api/v1/dashboard/stream", { preHandler: requireTenant }, async (request, reply) => {
    const tenant = request.tenant!;

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
        const [activity, workflows] = await Promise.all([
          pool.query(`SELECT event_count, last_event_at FROM projection_tenant_activity WHERE tenant_id = $1`, [
            tenant.tenantId,
          ]),
          pool.query(
            `SELECT execution_id, definition, status, current_step, step_count, correlation_id, error, updated_at
             FROM projection_workflow_summary WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 20`,
            [tenant.tenantId],
          ),
        ]);
        send("snapshot", {
          activity: activity.rows[0] ?? { event_count: 0, last_event_at: null },
          workflows: workflows.rows,
        });
      } catch (err: any) {
        send("error", { message: err.message });
      }
      await new Promise((r) => setTimeout(r, config.consumer.pollIntervalMs));
    }
  });
}
