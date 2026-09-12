/**
 * A workflow definition is an ordered list of steps. Each step is a pure
 * description of forward work and its compensation — the engine (not the
 * step) owns persistence, retry, timeout, and ordering, so step authors
 * only ever write business logic. See docs/adr on saga orchestration.
 */
export interface StepContext {
  executionId: string;
  tenantId: string;
  correlationId: string;
  /** Accumulated output of every step that has run so far, keyed by step name. */
  context: Record<string, unknown>;
}

export interface StepHandler {
  name: string;
  /** Max attempts for the forward action before compensation kicks in. */
  maxAttempts: number;
  timeoutMs: number;
  /** Returns data to merge into the execution's context under this step's name. */
  execute(ctx: StepContext): Promise<Record<string, unknown> | void>;
  /**
   * Undoes this step's effect. Only called for steps that previously
   * *succeeded* — compensation never runs for a step that never completed.
   * Compensations get their own retry budget (see engine) and must
   * themselves be idempotent, because a crash mid-compensation replays it.
   */
  compensate(ctx: StepContext): Promise<void>;
}

export interface WorkflowDefinition {
  name: string;
  /** The domain event type that starts a new execution of this workflow. */
  triggerEventType: string;
  steps: StepHandler[];
}
