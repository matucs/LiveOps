/**
 * In-process fault injection switches for the demo saga. This is the
 * seed of the Phase 05 chaos panel: an HTTP layer will flip these same
 * flags. Kept deliberately dumb (module-level mutable state, one-shot
 * flags) — the point is to make specific, real failures reproducible on
 * demand, not to build a generic fault-injection framework.
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

const state: ChaosState = {
  failNextPayment: false,
  failNextShipment: false,
  failPaymentAlways: false,
  failShipmentAlways: false,
};

export const chaos = {
  failNextPayment(): void {
    state.failNextPayment = true;
  },
  failNextShipment(): void {
    state.failNextShipment = true;
  },
  setPaymentAlwaysFails(v: boolean): void {
    state.failPaymentAlways = v;
  },
  setShipmentAlwaysFails(v: boolean): void {
    state.failShipmentAlways = v;
  },
  /** Consumes (and clears) the one-shot payment fault flag. */
  consumePaymentFault(): boolean {
    if (state.failPaymentAlways) return true;
    const v = state.failNextPayment;
    state.failNextPayment = false;
    return v;
  },
  consumeShipmentFault(): boolean {
    if (state.failShipmentAlways) return true;
    const v = state.failNextShipment;
    state.failNextShipment = false;
    return v;
  },
  snapshot(): ChaosState {
    return { ...state };
  },
};
