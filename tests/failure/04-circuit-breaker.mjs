import { API_URL, createTestTenant, post, assert, newEventId, poll, sleep } from "./helpers.mjs";

async function metricValue(name, labelMatch) {
  const res = await fetch(`${API_URL}/metrics`);
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (line.startsWith(name) && (!labelMatch || line.includes(labelMatch))) {
      return Number(line.trim().split(" ").pop());
    }
  }
  return undefined;
}

/**
 * Scenario: the payment provider fails repeatedly. Expected: after
 * enough consecutive failures the circuit breaker opens (state=2) and
 * further attempts fail fast (CircuitOpenError) instead of paying the
 * full timeout-and-retry cost against a dependency already known to be
 * down. Cleans up by clearing the fault and waiting past the reset
 * timeout so it doesn't leak into later tests.
 */
export async function run() {
  const { apiKey } = await createTestTenant("failure-test-circuit-breaker");

  await post("/api/v1/_dev/chaos", apiKey, { action: "fail-payment-always-on" });
  try {
    for (let i = 0; i < 3; i++) {
      await post("/api/v1/events", apiKey, { eventId: newEventId("evt_cb"), type: "order.created", payload: {} });
    }

    const state = await poll(async () => {
      const v = await metricValue("liveops_circuit_breaker_state", 'breaker="payment-provider"');
      return v === 2 ? v : null;
    });
    assert(state === 2, `expected circuit breaker state=2 (open), got ${state}`);
  } finally {
    await post("/api/v1/_dev/chaos", apiKey, { action: "fail-payment-always-off" });
    await sleep(5500); // past the breaker's resetTimeoutMs so it self-heals before the next test
  }

  return "3 consecutive payment failures -> circuit breaker opened (state=2), confirmed via /metrics";
}
