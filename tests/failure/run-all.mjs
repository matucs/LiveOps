#!/usr/bin/env node
/**
 * Runs every failure scenario in this directory, sequentially (several
 * rely on process-global chaos state or a shared Postgres container, so
 * parallel execution would make them interfere with each other — a
 * documented constraint, not an oversight).
 *
 * Assumes: `docker compose up -d postgres` and the API running on :3000
 * with RUN_WORKERS=true (npm run dev), except 05 and 06 which manage
 * their own process/container lifecycle directly.
 *
 * Usage: node tests/failure/run-all.mjs
 */
const scenarios = [
  ["01-duplicate-event", "./01-duplicate-event.mjs"],
  ["02-tenant-isolation", "./02-tenant-isolation.mjs"],
  ["03-saga-compensation", "./03-saga-compensation.mjs"],
  ["04-circuit-breaker", "./04-circuit-breaker.mjs"],
  ["05-process-crash-recovery", "./05-process-crash-recovery.mjs"],
  ["06-database-unavailable", "./06-database-unavailable.mjs"],
];

let passed = 0;
let failed = 0;

for (const [name, modulePath] of scenarios) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    const mod = await import(modulePath);
    const result = await mod.run();
    console.log(`PASS: ${result}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${scenarios.length} total`);
process.exit(failed > 0 ? 1 : 0);
