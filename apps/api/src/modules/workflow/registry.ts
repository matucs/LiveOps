import { orderFulfillmentWorkflow } from "./order-fulfillment.js";
import type { WorkflowDefinition } from "./types.js";

/**
 * The catalog of known workflow definitions. Static config, not write-side
 * runtime state — safe for the projection worker to read directly (e.g.
 * for each definition's total step count) without breaking the "read
 * models are derived only from the event log" rule that governs actual
 * mutable state.
 */
export const workflowDefinitions: WorkflowDefinition[] = [orderFulfillmentWorkflow];

export function stepCountFor(definitionName: string): number {
  return workflowDefinitions.find((d) => d.name === definitionName)?.steps.length ?? 0;
}
