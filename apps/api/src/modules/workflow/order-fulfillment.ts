import { chaos } from "./chaos.js";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
import type { StepContext, WorkflowDefinition } from "./types.js";
import { log, withSpan } from "../../shared/telemetry.js";

/**
 * The demo saga. Every "external call" here is simulated (a short delay
 * plus optional injected failure) — the point is the orchestration,
 * compensation, tracing, and circuit-breaker logic, not integrating real
 * payment/shipping providers. Steps 2-4 have compensations; validation
 * and notification do not (there is nothing to undo).
 *
 * The two genuinely external-shaped steps (charge-payment,
 * create-shipment) go through a CircuitBreaker: when the chaos panel's
 * "always fail" toggle is on, the third consecutive failure across ANY
 * execution opens that breaker, and every workflow's payment/shipment
 * step fails fast with CircuitOpenError for 5s instead of paying the
 * full timeout-then-retry cost per execution — a struggling dependency
 * doesn't get to also starve the connection pool. Re-exported from here
 * (not private) so the dashboard's reliability panel can show breaker
 * state without re-implementing the demo saga's wiring.
 */
export const paymentBreaker = new CircuitBreaker("payment-provider", 3, 5000);
export const shippingBreaker = new CircuitBreaker("shipping-carrier", 3, 5000);

export const orderFulfillmentWorkflow: WorkflowDefinition = {
  name: "order-fulfillment",
  triggerEventType: "order.created",
  steps: [
    {
      name: "validate-order",
      maxAttempts: 1,
      timeoutMs: 2000,
      async execute(ctx: StepContext) {
        log("info", "step: validate order", { executionId: ctx.executionId });
        return { validatedAt: new Date().toISOString() };
      },
      async compensate() {
        // Nothing to undo — validation has no external side effect.
      },
    },
    {
      name: "reserve-inventory",
      maxAttempts: 3,
      timeoutMs: 3000,
      async execute(ctx: StepContext) {
        log("info", "step: reserve inventory", { executionId: ctx.executionId });
        return { reservationId: `res_${ctx.executionId.slice(0, 8)}` };
      },
      async compensate(ctx: StepContext) {
        log("info", "compensate: release inventory", {
          executionId: ctx.executionId,
          reservationId: (ctx.context["reserve-inventory"] as any)?.reservationId,
        });
      },
    },
    {
      name: "charge-payment",
      maxAttempts: 3,
      timeoutMs: 3000,
      async execute(ctx: StepContext) {
        return paymentBreaker.execute(() =>
          withSpan("external.payment-provider", { executionId: ctx.executionId }, async () => {
            if (chaos.consumePaymentFault()) {
              throw new Error("payment provider declined the charge (injected fault)");
            }
            log("info", "step: charge payment", { executionId: ctx.executionId });
            return { chargeId: `chg_${ctx.executionId.slice(0, 8)}` };
          }),
        );
      },
      async compensate(ctx: StepContext) {
        await withSpan("external.payment-provider.refund", { executionId: ctx.executionId }, async () => {
          log("info", "compensate: refund payment", {
            executionId: ctx.executionId,
            chargeId: (ctx.context["charge-payment"] as any)?.chargeId,
          });
        });
      },
    },
    {
      name: "create-shipment",
      maxAttempts: 3,
      timeoutMs: 3000,
      async execute(ctx: StepContext) {
        return shippingBreaker.execute(() =>
          withSpan("external.shipping-carrier", { executionId: ctx.executionId }, async () => {
            if (chaos.consumeShipmentFault()) {
              throw new Error("shipping carrier rejected the label (injected fault)");
            }
            log("info", "step: create shipment", { executionId: ctx.executionId });
            return { shipmentId: `shp_${ctx.executionId.slice(0, 8)}` };
          }),
        );
      },
      async compensate(ctx: StepContext) {
        await withSpan("external.shipping-carrier.cancel", { executionId: ctx.executionId }, async () => {
          log("info", "compensate: cancel shipment", {
            executionId: ctx.executionId,
            shipmentId: (ctx.context["create-shipment"] as any)?.shipmentId,
          });
        });
      },
    },
    {
      name: "notify-customer",
      maxAttempts: 3,
      timeoutMs: 2000,
      async execute(ctx: StepContext) {
        log("info", "step: notify customer", { executionId: ctx.executionId });
        return { notifiedAt: new Date().toISOString() };
      },
      async compensate() {
        // Nothing to undo — a sent notification cannot be unsent.
      },
    },
  ],
};

export { CircuitOpenError };
