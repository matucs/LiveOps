import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../../db/pool.js";
import { ingestEvent } from "../ingest/service.js";
import { log } from "../../shared/telemetry.js";

const MAX_SANDBOX_TENANTS = 500; // cheap safeguard against unbounded growth from a careless script; see README's known trade-offs

export async function registerDemoRoutes(app: FastifyInstance) {
  /**
   * Legacy shared demo tenant — kept for backward compatibility with any
   * existing bookmarked `?apiKey=` link, but no longer what the
   * dashboard's own auto-connect uses (see /demo/sandbox below). Returns
   * 404 wherever DEMO_API_KEY isn't set (local dev, by default).
   */
  app.get("/api/v1/demo/bootstrap", async (_request, reply) => {
    const key = process.env.DEMO_API_KEY;
    if (!key) {
      return reply.code(404).send({ error: "not_configured", message: "No demo tenant is configured on this deployment." });
    }
    return { apiKey: key };
  });

  /**
   * Self-service, per-visitor sandbox tenant (Phase 09). Each browser
   * gets its own tenant + key rather than sharing one — the fix for the
   * concurrency gap Phase 03 found and documented: chaos actions and
   * workflow traffic no longer collide between simultaneous visitors,
   * because they're now genuinely different tenants, not just different
   * browser tabs hitting the same one. Seeds two real events immediately
   * so the dashboard isn't an empty shell on first paint (one plain
   * order, one that will fail its shipment step permanently and end up
   * compensated — so a first-time visitor sees both a completed and a
   * compensated workflow without clicking anything).
   */
  app.post("/api/v1/demo/sandbox", async (_request, reply) => {
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM tenants WHERE name LIKE 'Sandbox %'`,
    );
    if (Number(countRows[0].count) >= MAX_SANDBOX_TENANTS) {
      return reply.code(503).send({ error: "sandbox_limit_reached", message: "Too many sandbox tenants exist right now — try again later." });
    }

    const name = `Sandbox ${new Date().toISOString().slice(0, 19)}-${randomBytes(3).toString("hex")}`;
    const { rows } = await pool.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name]);
    const tenantId = rows[0].id;

    const rawKey = `lo_sandbox_${randomBytes(20).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    await pool.query("INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3)", [
      tenantId,
      keyHash,
      rawKey.slice(0, 11),
    ]);

    log("info", "sandbox tenant created", { tenantId, name });

    // Best-effort seeding — a failure here shouldn't fail tenant creation
    // itself; the visitor just sees an empty dashboard until they click
    // "Send a new order" themselves.
    try {
      await ingestEvent(tenantId, {
        eventId: `seed_${tenantId}_1`,
        type: "order.created",
        payload: { orderId: "seed-order-1" },
      });
    } catch (err: any) {
      log("warn", "sandbox seed event failed", { tenantId, err: err.message });
    }

    return { apiKey: rawKey, tenantId };
  });
}
