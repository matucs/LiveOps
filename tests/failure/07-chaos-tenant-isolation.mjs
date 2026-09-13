import { createTestTenant, post, pool, assert, newEventId, poll } from "./helpers.mjs";

/**
 * Scenario: two tenants trigger conflicting chaos actions at the same
 * moment — tenant A forces its shipment to always fail, tenant B forces
 * nothing. This is the actual regression test for the Phase 03 ->
 * Phase 09 fix: chaos state used to be one global flag set, so a fault
 * meant for one execution could land on a concurrently-running
 * execution belonging to a different tenant entirely (traced live via
 * step_executions in docs/phase-03-notes.md). Now scoped per tenant
 * (chaos.ts) — this asserts tenant B's workflow is completely unaffected
 * by tenant A's fault injection, even when both are in flight at once.
 */
export async function run() {
  const a = await createTestTenant("failure-test-chaos-iso-a");
  const b = await createTestTenant("failure-test-chaos-iso-b");

  await post("/api/v1/_dev/chaos", a.apiKey, { action: "fail-shipment-always-on" });
  try {
    const eventA = newEventId("evt_iso_a");
    const eventB = newEventId("evt_iso_b");

    // Fire both tenants' triggering events concurrently — the actual
    // race this test needs to exercise, not a sequential approximation.
    await Promise.all([
      post("/api/v1/events", a.apiKey, { eventId: eventA, type: "order.created", payload: {} }),
      post("/api/v1/events", b.apiKey, { eventId: eventB, type: "order.created", payload: {} }),
    ]);

    const p = pool();
    try {
      const [execA, execB] = await Promise.all([
        poll(async () => {
          const { rows } = await p.query(
            `SELECT status FROM workflow_executions WHERE tenant_id = $1 AND correlation_id = $2`,
            [a.tenantId, eventA],
          );
          return rows[0]?.status === "compensated" ? rows[0] : null;
        }),
        poll(async () => {
          const { rows } = await p.query(
            `SELECT status FROM workflow_executions WHERE tenant_id = $1 AND correlation_id = $2`,
            [b.tenantId, eventB],
          );
          return rows[0]?.status === "completed" ? rows[0] : null;
        }),
      ]);

      assert(execA.status === "compensated", `tenant A (fault injected) should be compensated, got ${execA.status}`);
      assert(execB.status === "completed", `tenant B (no fault) should complete normally, got ${execB.status} — chaos leaked across tenants`);
    } finally {
      await p.end();
    }
  } finally {
    await post("/api/v1/_dev/chaos", a.apiKey, { action: "fail-shipment-always-off" });
  }

  return "tenant A's shipment fault (concurrent with tenant B's clean run) -> A compensated, B completed normally — chaos does not leak across tenants";
}
