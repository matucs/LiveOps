import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

export const API_URL = process.env.API_URL ?? "http://localhost:3000";
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://liveops:liveops_dev_password@localhost:5434/liveops";

export function pool() {
  return new pg.Pool({ connectionString: DATABASE_URL });
}

/** Creates a fresh tenant + API key directly in the DB — isolated per
 * test run so failure tests never share state with each other or with
 * manual exploration against the same database. */
export async function createTestTenant(name) {
  const p = pool();
  try {
    const tenantId = (await p.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
    const rawKey = `lo_test_${randomBytes(16).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    await p.query("INSERT INTO api_keys (tenant_id, key_hash, key_prefix) VALUES ($1, $2, $3)", [
      tenantId,
      keyHash,
      rawKey.slice(0, 11),
    ]);
    return { tenantId, apiKey: rawKey };
  } finally {
    await p.end();
  }
}

export async function post(path, apiKey, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function get(path, apiKey) {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function poll(fn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`poll() timed out after ${timeoutMs}ms`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const rand = () => Math.random().toString(36).slice(2, 10);
export function newEventId(prefix = "evt") {
  return `${prefix}_${Date.now()}_${rand()}`;
}
