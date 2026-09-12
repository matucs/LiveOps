"use client";

import { useState } from "react";
import { triggerChaos, sendDemoOrder } from "@/lib/api";

const buttonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontSize: 12.5,
  fontWeight: 500,
  textAlign: "left",
};

const dangerStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "rgba(242,85,90,0.35)",
  color: "var(--red)",
};

export function ChaosPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  async function run(action: string, label: string) {
    setBusy(action);
    try {
      await triggerChaos(action);
      setLastAction(`${label} — armed`);
    } catch {
      setLastAction(`${label} — request failed (is the API reachable?)`);
    } finally {
      setBusy(null);
    }
  }

  async function fireOrder() {
    setBusy("send-order");
    try {
      await sendDemoOrder();
      setLastAction("Sent a new order.created event");
    } catch (e: any) {
      setLastAction(`Failed to send event: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button style={{ ...buttonStyle, borderColor: "var(--accent)", color: "var(--accent)" }} onClick={fireOrder} disabled={busy !== null}>
        ▶ Send a new order (happy path)
      </button>

      <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />

      <button style={buttonStyle} onClick={() => run("fail-next-payment", "Fail next payment (one-shot)")} disabled={busy !== null}>
        ⚡ Fail next payment (retries, then succeeds)
      </button>
      <button style={buttonStyle} onClick={() => run("fail-next-shipment", "Fail next shipment (one-shot)")} disabled={busy !== null}>
        ⚡ Fail next shipment (retries, then succeeds)
      </button>

      <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />

      <button style={dangerStyle} onClick={() => run("fail-payment-always-on", "Payment always fails")} disabled={busy !== null}>
        ✕ Force payment to always fail → full compensation
      </button>
      <button style={dangerStyle} onClick={() => run("fail-shipment-always-on", "Shipment always fails")} disabled={busy !== null}>
        ✕ Force shipment to always fail → full compensation
      </button>
      <button style={buttonStyle} onClick={() => run("fail-payment-always-off", "Payment fault cleared")} disabled={busy !== null}>
        ↺ Clear payment fault
      </button>
      <button style={buttonStyle} onClick={() => run("fail-shipment-always-off", "Shipment fault cleared")} disabled={busy !== null}>
        ↺ Clear shipment fault
      </button>

      {lastAction && <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 4 }}>{lastAction}</div>}
    </div>
  );
}
