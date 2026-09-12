import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { pool } from "../../db/pool.js";

export interface TenantContext {
  tenantId: string;
  apiKeyId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Resolves the caller's API key to a tenant context. This is the ONLY place
 * in the codebase that is allowed to turn a request into a tenant_id — every
 * query downstream takes tenantId as an explicit first argument rather than
 * re-deriving it, which is what makes cross-tenant leakage a one-file audit.
 */
export async function requireTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers["authorization"];
  const rawKey = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";

  if (!rawKey) {
    reply.code(401).send({ error: "missing_api_key", message: "Provide an API key as: Authorization: Bearer <key>" });
    return reply;
  }

  const keyHash = hashKey(rawKey);
  const { rows } = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash],
  );

  const row = rows[0];
  if (!row) {
    reply.code(401).send({ error: "invalid_api_key", message: "This API key is invalid or has been revoked." });
    return reply;
  }

  request.tenant = { tenantId: row.tenant_id, apiKeyId: row.id };
}
