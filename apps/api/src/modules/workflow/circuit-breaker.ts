import { log } from "../../shared/telemetry.js";
import { circuitBreakerState } from "../metrics/registry.js";

const STATE_VALUE: Record<State, number> = { closed: 0, "half-open": 1, open: 2 };

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`circuit breaker '${name}' is open — failing fast without calling the dependency`);
  }
}

type State = "closed" | "open" | "half-open";

/**
 * A per-dependency circuit breaker for the simulated external calls
 * (payment provider, shipping carrier). Purpose: when a downstream
 * dependency is genuinely down, stop hammering it with the same
 * timeout-then-retry cost on every single workflow step — fail fast
 * instead, so a struggling dependency doesn't also starve the
 * connection pool and workflow-engine concurrency that Phase 06 spent
 * effort protecting.
 *
 * Three states, the standard shape:
 * - closed: calls go through normally; consecutive failures are counted.
 * - open: calls fail immediately (CircuitOpenError) without touching the
 *   dependency, for `resetTimeoutMs`.
 * - half-open: after the timeout, exactly one call is let through as a
 *   probe. Success closes the circuit; failure re-opens it.
 *
 * State lives in memory, one instance per dependency, shared across all
 * workflow executions in this process — deliberately process-scoped, not
 * persisted: a circuit breaker's whole point is fast, cheap, local
 * decision-making, and a restart safely defaults back to closed (the
 * optimistic state) rather than needing to durably remember "the payment
 * provider was down 10 minutes ago."
 */
export class CircuitBreaker {
  private state: State = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number = 3,
    private readonly resetTimeoutMs: number = 5000,
  ) {
    circuitBreakerState.set({ breaker: this.name }, STATE_VALUE[this.state]);
  }

  private setState(state: State): void {
    this.state = state;
    circuitBreakerState.set({ breaker: this.name }, STATE_VALUE[state]);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.resetTimeoutMs) {
        throw new CircuitOpenError(this.name);
      }
      this.setState("half-open");
      log("warn", "circuit breaker half-open, probing", { breaker: this.name });
    }

    try {
      const result = await fn();
      if (this.state === "half-open") {
        log("info", "circuit breaker closed after successful probe", { breaker: this.name });
      }
      this.setState("closed");
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.state === "half-open" || this.consecutiveFailures >= this.failureThreshold) {
        this.setState("open");
        this.openedAt = Date.now();
        log("error", "circuit breaker opened", { breaker: this.name, consecutiveFailures: this.consecutiveFailures });
      }
      throw err;
    }
  }

  snapshot() {
    return { name: this.name, state: this.state, consecutiveFailures: this.consecutiveFailures };
  }
}
