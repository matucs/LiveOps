import { createTestTenant, post, pool, assert, newEventId } from "./helpers.mjs";

/**
 * Scenario: the same event is POSTed multiple times, as a caller retrying
 * a request whose response it never saw would. Expected: exactly one row,
 * every response after the first reports duplicate:true, and no error.
 */
export async function run() {
  const { tenantId, apiKey } = await createTestTenant("failure-test-duplicate");
  const eventId = newEventId("evt_dup");

  const responses = [];
  for (let i = 0; i < 5; i++) {
    responses.push(await post("/api/v1/events", apiKey, { eventId, type: "order.created", payload: {} }));
  }

  assert(responses[0].status === 201, `first request should be 201, got ${responses[0].status}`);
  assert(responses[0].body.duplicate === false, "first request should not report duplicate");
  for (let i = 1; i < responses.length; i++) {
    assert(responses[i].status === 200, `request ${i} should be 200, got ${responses[i].status}`);
    assert(responses[i].body.duplicate === true, `request ${i} should report duplicate:true`);
  }

  const p = pool();
  try {
    const { rows } = await p.query("SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND event_id = $2", [
      tenantId,
      eventId,
    ]);
    assert(rows[0].n === 1, `expected exactly 1 row, found ${rows[0].n}`);
  } finally {
    await p.end();
  }

  return `5 POSTs of the same eventId -> exactly 1 row, 1x 201 + 4x 200 duplicate:true`;
}
