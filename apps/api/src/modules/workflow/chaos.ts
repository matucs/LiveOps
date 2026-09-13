/**
 * In-process fault injection switches for the demo saga, scoped **per
 * tenant**. Phase 03 shipped this as a single global flag set and
 * documented the resulting limitation directly: with concurrent
 * workflows in flight, a one-shot fault landed on whichever execution's
 * step ran next, not necessarily the one a caller just triggered it for
 * — traced live via step_executions in docs/phase-03-notes.md. That's
 * fine for a solo demo and wrong for a public site with concurrent
 * visitors (Phase 09), so state is keyed by tenantId: two tenants
 * clicking "fail next payment" at the same moment no longer interfere
 * with each other. A tenant's own concurrent workflows can still race
 * each other — the same one-shot-flag limitation, just correctly scoped
 * to the blast radius of "one tenant," not "everyone on the site."
 */
interface ChaosState {
  /** Fails exactly one attempt, then clears — demonstrates retry-then-succeed. */
  failNextPayment: boolean;
  failNextShipment: boolean;
  /** Fails every attempt until turned off — exhausts retries, demonstrating
   *  full backward compensation. */
  failPaymentAlways: boolean;
  failShipmentAlways: boolean;
}

function emptyState(): ChaosState {
  return { failNextPayment: false, failNextShipment: false, failPaymentAlways: false, failShipmentAlways: false };
}

const perTenant = new Map<string, ChaosState>();

function stateFor(tenantId: string): ChaosState {
  let s = perTenant.get(tenantId);
  if (!s) {
    s = emptyState();
    perTenant.set(tenantId, s);
  }
  return s;
}

export const chaos = {
  failNextPayment(tenantId: string): void {
    stateFor(tenantId).failNextPayment = true;
  },
  failNextShipment(tenantId: string): void {
    stateFor(tenantId).failNextShipment = true;
  },
  setPaymentAlwaysFails(tenantId: string, v: boolean): void {
    stateFor(tenantId).failPaymentAlways = v;
  },
  setShipmentAlwaysFails(tenantId: string, v: boolean): void {
    stateFor(tenantId).failShipmentAlways = v;
  },
  /** Consumes (and clears) the one-shot payment fault flag for this tenant. */
  consumePaymentFault(tenantId: string): boolean {
    const s = stateFor(tenantId);
    if (s.failPaymentAlways) return true;
    const v = s.failNextPayment;
    s.failNextPayment = false;
    return v;
  },
  consumeShipmentFault(tenantId: string): boolean {
    const s = stateFor(tenantId);
    if (s.failShipmentAlways) return true;
    const v = s.failNextShipment;
    s.failNextShipment = false;
    return v;
  },
  snapshot(tenantId: string): ChaosState {
    return { ...stateFor(tenantId) };
  },
  /** Drops a tenant's chaos state entirely — used when a sandbox tenant
   * is retired, so this map doesn't grow unboundedly on a public demo
   * that mints a fresh tenant per visitor. */
  clear(tenantId: string): void {
    perTenant.delete(tenantId);
  },
};
