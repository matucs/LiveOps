import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_URL, createTestTenant, post, assert, sleep, poll } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

/**
 * Scenario: Postgres becomes unavailable mid-operation. Expected: ingest
 * fails cleanly (5xx, not a hang or a crash) while the DB is down, and
 * recovers on its own once the DB returns — pg.Pool reconnects
 * automatically, so there must be no special "reconnect" step for this
 * to pass.
 *
 * Targets whatever's already running on :3000 (the shared dev stack),
 * since this test needs to affect the SAME Postgres container other
 * tests/manual use — it always restores it before returning, restart
 * failure included, so a crash here doesn't leave the stack down for
 * whatever runs next.
 */
export async function run() {
  const { apiKey } = await createTestTenant("failure-test-db-down");

  execSync("docker compose stop postgres", { cwd: repoRoot, stdio: "ignore" });
  try {
    await sleep(500);
    const res = await post("/api/v1/events", apiKey, { eventId: "evt_db_down_probe", type: "order.created", payload: {} });
    assert(res.status >= 500, `expected a 5xx while the DB is down, got ${res.status}`);
  } finally {
    execSync("docker compose start postgres", { cwd: repoRoot, stdio: "ignore" });
  }

  await poll(
    async () => {
      try {
        const r = await fetch(`${API_URL}/healthz`);
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 20000 },
  );

  const recovered = await post("/api/v1/events", apiKey, {
    eventId: "evt_db_recovered",
    type: "order.created",
    payload: {},
  });
  assert(recovered.status === 201, `expected ingest to work again after DB recovery, got ${recovered.status}`);

  return "Postgres stopped -> ingest failed with 5xx; Postgres restarted -> ingest succeeded again with no manual intervention";
}
