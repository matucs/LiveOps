/**
 * Tracing seam (see docs/adr — observability). In V1 this is a passthrough:
 * it exists purely so every call site that will eventually need a span is
 * already wrapped. Swapping the body for real OpenTelemetry spans later
 * requires touching this file only — no call site changes.
 */
export async function withSpan<T>(
  _name: string,
  _attrs: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields }));
}
