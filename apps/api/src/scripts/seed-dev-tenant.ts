import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";

/**
 * Creates a dev tenant + API key for local testing and prints the raw key
 * ONCE (it is stored only as a hash, exactly like production callers).
 * Re-running this is safe: it reuses a tenant named "Dev Tenant" if present
 * but always issues a fresh key.
 */
async function main() {
  const tenantName = process.argv[2] ?? "Dev Tenant";

  const existing = await pool.query<{ id: string }>("SELECT id FROM tenants WHERE name = $1 LIMIT 1", [tenantName]);
  const tenantId =
    existing.rows[0]?.id ??
    (await pool.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [tenantName])).rows[0].id;

  const rawKey = `lo_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 11);

  await pool.query(
    "INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3)",
    [tenantId, keyHash, keyPrefix],
  );

  console.log(`tenant:   ${tenantName} (${tenantId})`);
  console.log(`api key:  ${rawKey}`);
  console.log(`\nExample:`);
  console.log(
    `curl -s localhost:3000/api/v1/events -H "Authorization: Bearer ${rawKey}" -H "Content-Type: application/json" -d '{"eventId":"evt_1","type":"order.created","payload":{"orderId":"ord_1"}}'`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
