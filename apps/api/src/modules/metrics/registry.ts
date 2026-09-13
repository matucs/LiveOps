import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * The metrics registry. In-process, no extra server, no extra memory
 * budget worth worrying about on the small production VM (ADR-009) —
 * unlike tracing (ADR-011), this is cheap enough to run everywhere,
 * always. Scraped via GET /metrics (server.ts).
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "liveops_process_" });

export const httpRequestsTotal = new Counter({
  name: "liveops_http_requests_total",
  help: "HTTP requests handled, by route and status code",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "liveops_http_request_duration_seconds",
  help: "HTTP request duration in seconds, by route",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const eventsIngestedTotal = new Counter({
  name: "liveops_events_ingested_total",
  help: "Events successfully ingested (excludes duplicates), by tenant",
  labelNames: ["tenantId"],
  registers: [registry],
});

export const workflowCompletedTotal = new Counter({
  name: "liveops_workflow_completed_total",
  help: "Workflow executions that reached 'completed'",
  labelNames: ["definition"],
  registers: [registry],
});

export const workflowCompensatedTotal = new Counter({
  name: "liveops_workflow_compensated_total",
  help: "Workflow executions that reached 'compensated'",
  labelNames: ["definition"],
  registers: [registry],
});

export const workflowFailedTotal = new Counter({
  name: "liveops_workflow_failed_total",
  help: "Workflow executions that reached 'failed' (a compensation itself exhausted retries)",
  labelNames: ["definition"],
  registers: [registry],
});

export const consumerLag = new Gauge({
  name: "liveops_consumer_lag",
  help: "Event log position minus this consumer group's committed checkpoint",
  labelNames: ["group"],
  registers: [registry],
});

export const deadLettersOpen = new Gauge({
  name: "liveops_dead_letters_open",
  help: "Dead letters not yet replayed",
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: "liveops_circuit_breaker_state",
  help: "0=closed 1=half-open 2=open",
  labelNames: ["breaker"],
  registers: [registry],
});
