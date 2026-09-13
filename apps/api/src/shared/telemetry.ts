import { trace, context, SpanStatusCode, TraceFlags, type Attributes, type SpanContext } from "@opentelemetry/api";

/**
 * Tracing (ADR-011, docs/observability.md). The OTel SDK itself is
 * bootstrapped separately (`otel/register.mjs`, loaded via `node --import`
 * before this module or anything else in the process) — this file only
 * creates spans using whatever tracer provider that bootstrap installed.
 * When no SDK was started (OTEL_EXPORTER_OTLP_ENDPOINT unset — always in
 * production, see docs/observability.md), OTel's API falls back to a
 * no-op tracer automatically: this code needs no `if` to disable itself,
 * and callers never need to know which case they're in.
 */
const tracer = trace.getTracer("liveops-api");

async function runSpan<T>(name: string, attrs: Attributes, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function withSpan<T>(name: string, attrs: Attributes, fn: () => Promise<T>): Promise<T> {
  return runSpan(name, attrs, fn);
}

/**
 * Starts a span as a child of a trace/span pair read back from a
 * database row rather than from the ambient async context — this is
 * what makes "HTTP request -> outbox -> consumer -> workflow step ->
 * external call" one continuous trace instead of four disconnected ones:
 * the workflow engine's tick runs in an entirely separate async loop
 * (and possibly a different process, after a restart) from the HTTP
 * request that originally started the trace, so there is no ambient
 * context left to inherit it from by the time a step actually runs.
 * `parent` fields double as "no stored trace" when absent (older rows,
 * or a system with tracing recently enabled) — falls back to an
 * unlinked span rather than erroring.
 */
export async function withLinkedSpan<T>(
  parent: { traceId?: string | null; spanId?: string | null },
  name: string,
  attrs: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  if (!parent.traceId || !parent.spanId) return runSpan(name, attrs, fn);

  const remoteContext: SpanContext = {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  const ctxWithParent = trace.setSpanContext(context.active(), remoteContext);
  return context.with(ctxWithParent, () => runSpan(name, attrs, fn));
}

/**
 * Reads the currently active span's IDs, for persisting alongside a row
 * (see `withLinkedSpan`) or for including in a log line.
 *
 * When no SDK is running (production, or any local run without
 * OTEL_EXPORTER_OTLP_ENDPOINT set), the no-op tracer still returns a
 * span from `startActiveSpan` — it just carries the spec's reserved
 * all-zero "invalid" SpanContext, not `undefined`. Checked explicitly
 * here (`trace.isSpanContextValid`) rather than trusting a merely
 * non-null value: an event ingested while tracing was off would
 * otherwise persist that all-zero ID as if it were a real trace,
 * and a later `withLinkedSpan` reading it back would try to extend an
 * unextendable context instead of correctly falling back to a fresh
 * root span. Found while testing backpressure with tracing
 * intentionally off, then re-enabled — exactly the kind of gap this
 * project's whole discipline is to catch by actually running it.
 */
export function currentTraceContext(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const ctx = span.spanContext();
  if (!trace.isSpanContextValid(ctx)) return {};
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...currentTraceContext(), ...fields }));
}
