import type { FastifyInstance } from "fastify";
import { requireTenant } from "../tenant/auth.js";
import { pool } from "../../db/pool.js";

/**
 * The Query side of CQRS. Throughput, workflow, and activity routes read
 * only `projection_*` tables — no business logic, just the shape the
 * projection worker already computed. The dead-letters route is the one
 * exception: it joins back to `events`/`workflow_executions` because that
 * join is the only correct way to enforce tenant isolation on a table with
 * no `tenant_id` column of its own (see the route). Read-only joins for
 * access control are fine; the rule this module actually holds to is
 * "never derive or recompute business state here" — that stays the
 * projection worker's job alone.
 */
export async function registerProjectionRoutes(app: FastifyInstance) {
  app.get("/api/v1/dashboard/throughput", { preHandler: requireTenant }, async (request) => {
    const tenant = request.tenant!;
    const { rows } = await pool.query(
      `SELECT minute, event_count FROM projection_throughput_minute
       WHERE tenant_id = $1 AND minute > now() - interval '1 hour'
       ORDER BY minute ASC`,
      [tenant.tenantId],
    );
    return { throughput: rows };
  });

  app.get("/api/v1/dashboard/workflows", { preHandler: requireTenant }, async (request) => {
    const tenant = request.tenant!;
    const { rows } = await pool.query(
      `SELECT execution_id, definition, status, current_step, step_count, correlation_id, error, updated_at
       FROM projection_workflow_summary WHERE tenant_id = $1
       ORDER BY updated_at DESC LIMIT 50`,
      [tenant.tenantId],
    );
    return { workflows: rows };
  });

  app.get("/api/v1/dashboard/activity", { preHandler: requireTenant }, async (request) => {
    const tenant = request.tenant!;
    const { rows } = await pool.query(
      `SELECT event_count, last_event_at FROM projection_tenant_activity WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    return { activity: rows[0] ?? { event_count: 0, last_event_at: null } };
  });

  app.get("/api/v1/dashboard/dead-letters", { preHandler: requireTenant }, async (request) => {
    const tenant = request.tenant!;
    // dead_letters has no tenant_id column of its own (it references
    // either an event or a workflow execution, never both) — derive the
    // tenant by joining through whichever reference is set. Getting this
    // filter right matters here specifically: "can tenant A see tenant B's
    // failures" is exactly the kind of leak that's easy to miss on an
    // operational/debug table that feels lower-stakes than business data.
    const { rows } = await pool.query(
      `SELECT dl.id, dl.source, dl.attempts, dl.last_error, dl.created_at, dl.replayed_at
       FROM dead_letters dl
       LEFT JOIN events e ON e.seq = dl.event_seq
       LEFT JOIN workflow_executions we ON we.id = dl.execution_id
       WHERE COALESCE(e.tenant_id, we.tenant_id) = $1
       ORDER BY dl.created_at DESC LIMIT 50`,
      [tenant.tenantId],
    );
    return { deadLetters: rows };
  });
}
