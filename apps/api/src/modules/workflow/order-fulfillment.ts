import { chaos } from "./chaos.js";
import type { StepContext, WorkflowDefinition } from "./types.js";
import { log } from "../../shared/telemetry.js";

/**
 * The demo saga. Every "external call" here is simulated (a short delay
 * plus optional injected failure) — the point is the orchestration and
 * compensation logic, not integrating real payment/shipping providers.
 * Steps 2-4 have compensations; validation and notification do not
 * (there is nothing to undo).
 */
export const orderFulfillmentWorkflow: WorkflowDefinition = {
  name: "order-fulfillment",
  triggerEventType: "order.created",
  steps: [
    {
      name: "validate-order",
      maxAttempts: 1,
      timeoutMs: 2000,
      async execute(ctx: StepContext) {
        const orderId = ctx.context.trigger as Record<string, unknown> | undefined;
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
        if (chaos.consumePaymentFault()) {
          throw new Error("payment provider declined the charge (injected fault)");
        }
        log("info", "step: charge payment", { executionId: ctx.executionId });
        return { chargeId: `chg_${ctx.executionId.slice(0, 8)}` };
      },
      async compensate(ctx: StepContext) {
        log("info", "compensate: refund payment", {
          executionId: ctx.executionId,
          chargeId: (ctx.context["charge-payment"] as any)?.chargeId,
        });
      },
    },
    {
      name: "create-shipment",
      maxAttempts: 3,
      timeoutMs: 3000,
      async execute(ctx: StepContext) {
        if (chaos.consumeShipmentFault()) {
          throw new Error("shipping carrier rejected the label (injected fault)");
        }
        log("info", "step: create shipment", { executionId: ctx.executionId });
        return { shipmentId: `shp_${ctx.executionId.slice(0, 8)}` };
      },
      async compensate(ctx: StepContext) {
        log("info", "compensate: cancel shipment", {
          executionId: ctx.executionId,
          shipmentId: (ctx.context["create-shipment"] as any)?.shipmentId,
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
