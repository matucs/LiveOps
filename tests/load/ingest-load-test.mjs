#!/usr/bin/env node
/**
 * Sustained-load test against POST /api/v1/events. Measures p50/p95/p99
 * ingest latency and observed throughput at increasing concurrency, and
 * (separately) drains and reports consumer lag afterward so the test
 * shows not just "how fast can we accept events" but "how far behind
 * does the async pipeline fall while we do."
 *
 * Usage: API_KEY=lo_... node tests/load/ingest-load-test.mjs
 */
import { performance } from "node:perf_hooks";
import pg from "pg";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) {
  console.error("Set API_KEY (see: npm run --workspace apps/api seed:dev-tenant)");
  process.exit(1);
}

const RUN_ID = `loadtest_${Date.now()}`;

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function fireOne(waveLabel, seq) {
  // waveLabel makes this globally unique across waves, not just within
  // one — each wave's `next` counter independently starts at 0, so
  // without a per-wave prefix, "moderate" would re-send every ID
  // "warmup" already used, "high" would re-send moderate's AND
  // warmup's, and so on. Those resends are correctly rejected as
  // duplicates (idempotency working as designed) — but a duplicate
  // rejection still consumes a BIGSERIAL sequence value without ever
  // creating a row (the exact gap mechanism documented in
  // docs/phase-03-notes.md), which silently inflated max(seq) past the
  // true number of real events every wave actually created. That
  // inflated target is what made a later drain check's "lag" plateau at
  // a small, never-closing residual instead of reaching zero — a
  // measurement bug in this script, not in the pipeline it measures.
  // Found and fixed during the V2 Kafka migration's load test
  // (docs/phase-10-notes.md).
  const eventId = `${RUN_ID}_${waveLabel}_${seq}`;
  const start = performance.now();
  const res = await fetch(`${API_URL}/api/v1/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, type: "order.created", payload: { orderId: eventId } }),
  });
  const elapsed = performance.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.json();
  return elapsed;
}

/** Runs `total` requests at `concurrency` in-flight at once, returns latencies (ms). */
async function runWave(waveLabel, total, concurrency) {
  const latencies = [];
  let next = 0;
  let errors = 0;

  async function worker() {
    while (next < total) {
      const seq = next++;
      try {
        latencies.push(await fireOne(waveLabel, seq));
      } catch {
        errors++;
      }
    }
  }

  const wallStart = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - wallStart;

  return { latencies, errors, wallMs };
}

function report(label, total, concurrency, { latencies, errors, wallMs }) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const throughput = (latencies.length / (wallMs / 1000)).toFixed(1);
  console.log(`\n== ${label} (concurrency=${concurrency}, requests=${total}) ==`);
  console.log(`  wall time:    ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`  throughput:   ${throughput} req/s`);
  console.log(`  errors:       ${errors}`);
  console.log(`  p50:          ${percentile(sorted, 50).toFixed(1)}ms`);
  console.log(`  p95:          ${percentile(sorted, 95).toFixed(1)}ms`);
  console.log(`  p99:          ${percentile(sorted, 99).toFixed(1)}ms`);
  console.log(`  max:          ${sorted[sorted.length - 1]?.toFixed(1)}ms`);
  return { throughput: Number(throughput), p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
}

async function measureDrainTime(pool, expectedTotal) {
  // Poll consumer_checkpoints until all three groups have caught up to the
  // event log's max seq, to see how far the async pipeline lagged behind
  // ingest under load and how long it took to catch up.
  const { rows: maxSeqRows } = await pool.query("SELECT max(seq)::bigint AS max_seq FROM events");
  const targetSeq = maxSeqRows[0].max_seq;

  const start = performance.now();
  let lastLagReport = 0;
  while (true) {
    const { rows } = await pool.query(
      "SELECT handler, last_seq FROM consumer_checkpoints WHERE handler IN ('audit-log', 'workflow-trigger:order-fulfillment', 'projection-worker')",
    );
    const minSeq = Math.min(...rows.map((r) => Number(r.last_seq)));
    const lag = Number(targetSeq) - minSeq;
    const elapsed = performance.now() - start;
    if (elapsed - lastLagReport > 1000) {
      console.log(`  draining... lag=${lag} events, elapsed=${(elapsed / 1000).toFixed(1)}s`);
      lastLagReport = elapsed;
    }
    if (lag <= 0) {
      console.log(`  drained: all consumer groups caught up to seq ${targetSeq} in ${(elapsed / 1000).toFixed(2)}s`);
      return elapsed;
    }
    if (elapsed > 60_000) {
      console.log(`  WARNING: drain exceeded 60s, giving up (lag=${lag})`);
      return elapsed;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  console.log(`LiveOps ingest load test — target ${API_URL}, run ${RUN_ID}`);

  const waves = [
    { label: "warmup", total: 200, concurrency: 10 },
    { label: "moderate", total: 1000, concurrency: 25 },
    { label: "high", total: 2000, concurrency: 50 },
    { label: "burst", total: 3000, concurrency: 100 },
  ];

  const results = [];
  for (const wave of waves) {
    const outcome = await runWave(wave.label, wave.total, wave.concurrency);
    results.push({ ...wave, ...report(wave.label, wave.total, wave.concurrency, outcome) });
  }

  if (DATABASE_URL) {
    console.log("\n== Drain: how long for the async pipeline to catch up after the burst wave ==");
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await measureDrainTime(pool, results.at(-1).total);
    await pool.end();
  } else {
    console.log("\n(Set DATABASE_URL to also measure consumer drain time after the burst.)");
  }

  console.log("\n== Summary ==");
  console.table(results.map((r) => ({ wave: r.label, concurrency: r.concurrency, "req/s": r.throughput, p50_ms: r.p50.toFixed(1), p95_ms: r.p95.toFixed(1), p99_ms: r.p99.toFixed(1) })));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
