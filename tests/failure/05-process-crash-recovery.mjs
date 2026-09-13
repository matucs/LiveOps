import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTenant, post, pool, assert, sleep, poll } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const PORT = 3099;
const BASE = `http://localhost:${PORT}`;

function startServer(env) {
  const child = spawn(
    "node",
    ["--import", "./apps/api/src/otel/register.mjs", "--import", "tsx/esm", "apps/api/src/server.ts"],
    { cwd: repoRoot, env: { ...process.env, ...env, PORT: String(PORT) }, stdio: "ignore" },
  );
  return child;
}

async function waitHealthy(timeoutMs = 10000) {
  await poll(
    async () => {
      try {
        const res = await fetch(`${BASE}/healthz`);
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs, intervalMs: 200 },
  );
}

/**
 * Scenario: the API process is killed -9 mid-burst — the exact test done
 * manually in Phase 02 (docs/phase-02-notes.md), automated here. Spawns
 * its own dedicated instance on a separate port so it never disturbs
 * whatever's already running on :3000; shares the same Postgres, so
 * durability is real, not simulated.
 */
export async function run() {
  const { tenantId, apiKey } = await createTestTenant("failure-test-crash-recovery");

  let server = startServer({ RUN_WORKERS: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "" });
  await waitHealthy();

  const total = 60;
  const sends = Array.from({ length: total }, (_, i) =>
    fetch(`${BASE}/api/v1/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: `evt_crash_${i}`, type: "order.created", payload: {} }),
    }).catch(() => null),
  );

  const p = pool();
  try {
    // Poll for real landed rows instead of guessing a fixed delay — a
    // fixed sleep() here previously let 0 events land before the kill on
    // a fast machine, making the test pass trivially (0 duplicates of
    // nothing, 0 completed workflows out of 0 events) without actually
    // exercising crash-mid-flight recovery at all. Require a nonzero
    // landed count explicitly below so that failure mode can't recur
    // silently.
    await poll(
      async () => {
        const { rows } = await p.query(`SELECT count(*)::int AS n FROM events WHERE tenant_id = $1`, [tenantId]);
        return rows[0].n > 0 ? true : null;
      },
      { timeoutMs: 5000, intervalMs: 2 },
    );

    assert(server.kill("SIGKILL"), "failed to send SIGKILL to the test server process");
    await Promise.allSettled(sends);
    await sleep(300); // let the OS fully release the port

    const beforeRestart = await p.query(
      `SELECT count(*)::int AS n FROM events WHERE tenant_id = $1`,
      [tenantId],
    );
    assert(beforeRestart.rows[0].n > 0, "expected at least one event to have landed before the kill — the test proved nothing otherwise");

    // Restart — this is the actual recovery mechanism under test: the same
    // lease-based claiming every worker uses (ADR-009's failure-recovery
    // pattern), no special recovery-mode code path.
    server = startServer({ RUN_WORKERS: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "" });
    await waitHealthy();

    await poll(
      async () => {
        const { rows } = await p.query(
          `SELECT count(*)::int AS n FROM workflow_executions WHERE tenant_id = $1 AND status = 'completed'`,
          [tenantId],
        );
        return rows[0].n >= beforeRestart.rows[0].n ? rows[0] : null;
      },
      { timeoutMs: 20000 },
    );

    const { rows: eventCount } = await p.query(`SELECT count(*)::int AS n FROM events WHERE tenant_id = $1`, [tenantId]);
    const { rows: dupCheck } = await p.query(
      `SELECT event_id, count(*)::int AS n FROM events WHERE tenant_id = $1 GROUP BY event_id HAVING count(*) > 1`,
      [tenantId],
    );
    const { rows: completedCount } = await p.query(
      `SELECT count(*)::int AS n FROM workflow_executions WHERE tenant_id = $1 AND status = 'completed'`,
      [tenantId],
    );

    assert(dupCheck.length === 0, `found duplicate event rows after crash+restart: ${JSON.stringify(dupCheck)}`);
    assert(
      completedCount[0].n === eventCount[0].n,
      `expected every landed event's workflow to complete (${eventCount[0].n} events, ${completedCount[0].n} completed)`,
    );

    return `killed -9 mid-burst (${eventCount[0].n}/${total} events landed before death), restarted: 0 duplicates, all ${completedCount[0].n} workflows completed`;
  } finally {
    server.kill("SIGKILL");
    await p.end();
  }
}
