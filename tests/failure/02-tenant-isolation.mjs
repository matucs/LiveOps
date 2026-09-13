import { createTestTenant, post, get, assert, newEventId, poll } from "./helpers.mjs";

/**
 * Scenario: two tenants, tenant A ingests events and produces workflows
 * and dashboard activity; tenant B's credentials must see none of it.
 * Exercises the actual auth/query path (ADR-008's single tenant-
 * resolution chokepoint), not just the schema.
 */
export async function run() {
  const a = await createTestTenant("failure-test-tenant-a");
  const b = await createTestTenant("failure-test-tenant-b");

  const eventId = newEventId("evt_iso");
  const ingest = await post("/api/v1/events", a.apiKey, { eventId, type: "order.created", payload: {} });
  assert(ingest.status === 201, `tenant A ingest should succeed, got ${ingest.status}`);

  // Wait for tenant A's workflow to actually appear, so this test proves
  // isolation against REAL populated state, not an empty table both
  // tenants would trivially "pass" against.
  await poll(async () => {
    const { body } = await get("/api/v1/dashboard/workflows", a.apiKey);
    return body.workflows?.length > 0;
  });

  const [aActivity, bActivity] = await Promise.all([
    get("/api/v1/dashboard/activity", a.apiKey),
    get("/api/v1/dashboard/activity", b.apiKey),
  ]);
  assert(Number(aActivity.body.activity.event_count) >= 1, "tenant A should see its own event");
  assert(Number(bActivity.body.activity.event_count) === 0, "tenant B must see zero events — none of these are its own");

  const [aWorkflows, bWorkflows] = await Promise.all([
    get("/api/v1/dashboard/workflows", a.apiKey),
    get("/api/v1/dashboard/workflows", b.apiKey),
  ]);
  assert(aWorkflows.body.workflows.length >= 1, "tenant A should see its own workflow");
  assert(bWorkflows.body.workflows.length === 0, "tenant B must see zero workflows — cross-tenant leak");

  // Direct attempt: tenant B tries to fetch tenant A's own workflow ID.
  const executionId = aWorkflows.body.workflows[0].execution_id;
  const directAttempt = await get(`/api/v1/workflows/${executionId}`, b.apiKey);
  assert(directAttempt.status === 404, `tenant B fetching tenant A's execution ID directly should 404, got ${directAttempt.status}`);

  return `tenant B: 0 events, 0 workflows, 404 on tenant A's execution ID — isolation holds under real populated state`;
}
