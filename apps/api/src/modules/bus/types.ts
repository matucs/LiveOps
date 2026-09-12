/**
 * Transport-agnostic event bus. Postgres implements this in V1 (see
 * `postgres-bus.ts`); a Kafka implementation can satisfy the exact same
 * interface later with zero changes to any caller. This seam is what makes
 * the V1 -> V2 transport migration a swap instead of a rewrite.
 */
export interface BusMessage {
  /** Monotonic position in the source-of-truth log (events.seq). */
  seq: string;
  eventId: string;
  tenantId: string;
  type: string;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export type Handler = (message: BusMessage) => Promise<void>;

export interface EventBus {
  /**
   * Registers a durable consumer group. Each group tracks its own
   * checkpoint and sees every message on `topic` independently of any
   * other group — mirrors Kafka consumer-group semantics.
   */
  subscribe(topic: string, group: string, handler: Handler): void;

  /** Starts all registered subscriptions' poll loops. */
  start(): void;

  /** Stops poll loops; in-flight batches are allowed to finish. */
  stop(): Promise<void>;
}
