import { createTestTenant, post, pool, assert, newEventId, poll } from "./helpers.mjs";

/**
 * Scenario: a step permanently fails, forcing full backward compensation.
 * Asserts the exact reverse order and that the step which never
 * succeeded forward is correctly excluded from compensation — this is
 * the specific behavior Phase 03 verified manually; automated here so it
 * regresses loudly instead of silently.
 *
 * Note: the chaos toggles are process-global (a known limitation, see
 * docs/phase-03-notes.md) — this test only holds correctly when nothing
 * else is concurrently exercising the same fault flags.
 */
export async function run() {
  const { tenantId, apiKey } = await createTestTenant("failure-test-compensation");

  await post("/api/v1/_dev/chaos", apiKey, { action: "fail-shipment-always-on" });
  try {
    const eventId = newEventId("evt_comp");
    await post("/api/v1/events", apiKey, { eventId, type: "order.created", payload: {} });

    const p = pool();
    try {
      const execution = await poll(async () => {
        const { rows } = await p.query(
          `SELECT id, status FROM workflow_executions WHERE tenant_id = $1 AND correlation_id = $2`,
          [tenantId, eventId],
        );
        return rows[0]?.status === "compensated" ? rows[0] : null;
      });

      const { rows: steps } = await p.query(
        `SELECT step_index, step_name, direction, status FROM step_executions WHERE execution_id = $1 ORDER BY started_at`,
        [execution.id],
      );

      const shipmentAttempts = steps.filter((s) => s.step_name === "create-shipment" && s.direction === "forward");
      assert(shipmentAttempts.length === 3, `create-shipment should attempt 3 times, saw ${shipmentAttempts.length}`);
      assert(
        shipmentAttempts.every((s) => s.status === "failed"),
        "every create-shipment attempt should have failed",
      );

      const shipmentCompensated = steps.some((s) => s.step_name === "create-shipment" && s.direction === "compensate");
      assert(!shipmentCompensated, "create-shipment never succeeded forward — it must NOT appear in compensation");

      const compensateOrder = steps.filter((s) => s.direction === "compensate" && s.status === "succeeded").map((s) => s.step_name);
      assert(
        JSON.stringify(compensateOrder) === JSON.stringify(["charge-payment", "reserve-inventory", "validate-order"]),
        `compensation order wrong: ${JSON.stringify(compensateOrder)}`,
      );
    } finally {
      await p.end();
    }
  } finally {
    await post("/api/v1/_dev/chaos", apiKey, { action: "fail-shipment-always-off" });
  }

  return "shipment failed permanently -> compensated in exact reverse order, shipment itself excluded";
}
