import type { FastifyInstance } from "fastify";
import { requireTenant } from "../tenant/auth.js";
import { pool } from "../../db/pool.js";
import { chaos } from "./chaos.js";

/**
 * Read routes for inspecting workflow executions directly (bypassing
 * projections, which don't exist yet — Phase 04). Also hosts a dev-only
 * chaos toggle so Phase 03's saga paths (retry-then-succeed,
 * retry-then-compensate) can be exercised without a UI; Phase 05 replaces
 * this with the real chaos panel wired the same way.
 */
export async function registerWorkflowQueryRoutes(app: FastifyInstance) {
  app.get("/api/v1/workflows", { preHandler: requireTenant }, async (request) => {
    const tenant = request.tenant!;
    const { rows } = await pool.query(
      `SELECT id, definition, status, current_step, error, correlation_id, created_at, updated_at
       FROM workflow_executions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [tenant.tenantId],
    );
    return { executions: rows };
  });

  app.get<{ Params: { id: string } }>("/api/v1/workflows/:id", { preHandler: requireTenant }, async (request, reply) => {
    const tenant = request.tenant!;
    const { rows } = await pool.query(
      `SELECT id, definition, status, current_step, context, error, correlation_id, created_at, updated_at
       FROM workflow_executions WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, request.params.id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });

    const { rows: steps } = await pool.query(
      `SELECT step_index, step_name, direction, status, attempts, error, started_at, finished_at
       FROM step_executions WHERE execution_id = $1 ORDER BY started_at ASC`,
      [request.params.id],
    );
    return { execution: rows[0], steps };
  });

  // Dev-only fault injection — no tenant scoping needed, it's process-global
  // in-memory state for a single-tenant local demo. Superseded by the real
  // chaos panel in Phase 05.
  app.post<{ Body: { action: string } }>("/api/v1/_dev/chaos", async (request, reply) => {
    switch (request.body?.action) {
      case "fail-next-payment":
        chaos.failNextPayment();
        break;
      case "fail-next-shipment":
        chaos.failNextShipment();
        break;
      case "fail-payment-always-on":
        chaos.setPaymentAlwaysFails(true);
        break;
      case "fail-payment-always-off":
        chaos.setPaymentAlwaysFails(false);
        break;
      case "fail-shipment-always-on":
        chaos.setShipmentAlwaysFails(true);
        break;
      case "fail-shipment-always-off":
        chaos.setShipmentAlwaysFails(false);
        break;
      default:
        return reply.code(400).send({ error: "unknown_action" });
    }
    return { chaos: chaos.snapshot() };
  });
}
