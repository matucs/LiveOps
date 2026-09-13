"use client";

import { useEffect, useRef, useState } from "react";
import { getApiUrl, getApiKey, setCredentials, fetchDemoKey } from "@/lib/api";
import { ConnectionBar } from "@/components/ConnectionBar";
import { ChaosPanel } from "@/components/ChaosPanel";
import { WorkflowList, type WorkflowSummary } from "@/components/WorkflowList";
import { Sparkline } from "@/components/Sparkline";
import { DeadLetterPanel } from "@/components/DeadLetterPanel";

interface Snapshot {
  activity: { event_count: string | number; last_event_at: string | null };
  workflows: WorkflowSummary[];
  throughput: { minute: string; event_count: number }[];
  openDeadLetters: number;
}

const card: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 18,
};

const label: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--text-faint)",
  marginBottom: 6,
};

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  // Lets a link like /?apiUrl=...&apiKey=... bootstrap credentials directly
  // — useful for a shareable demo link so a viewer doesn't have to run the
  // seed script themselves to see a live dashboard.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlKey = params.get("apiKey");
    if (urlKey) {
      setCredentials(params.get("apiUrl") || getApiUrl(), urlKey);
      window.history.replaceState({}, "", window.location.pathname);
      setTick((t) => t + 1);
      return;
    }
    // No stored or URL-provided key: try the deployment's public demo
    // tenant, if one is configured, so a fresh visitor sees real data
    // immediately rather than a "connect first" wall.
    if (!getApiKey()) {
      fetchDemoKey().then((key) => {
        if (key) {
          setCredentials(getApiUrl(), key);
          setTick((t) => t + 1);
        }
      });
    }
  }, []);

  useEffect(() => {
    const apiUrl = getApiUrl();
    const apiKey = getApiKey();
    if (!apiKey) {
      setConnected(false);
      return;
    }

    // EventSource can't set custom headers, so the API key travels as a
    // query param for this connection only — acceptable for a local demo
    // (see docs); a production deployment would use a short-lived stream
    // token instead of the raw key.
    const url = `${apiUrl}/api/v1/dashboard/stream?token=${encodeURIComponent(apiKey)}`;
    const es = new EventSource(url, { withCredentials: false } as any);
    esRef.current = es;

    es.addEventListener("snapshot", (ev: MessageEvent) => {
      setConnected(true);
      setSnapshot(JSON.parse(ev.data));
    });
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [tick]);

  const noCreds = !getApiKey();

  return (
    <div style={{ minHeight: "100vh" }}>
      <ConnectionBar onSaved={() => setTick((t) => t + 1)} />

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 20px 60px" }}>
        <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: -0.3 }}>LiveOps</h1>
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "4px 0 0" }}>
              Real-time event processing &amp; workflow platform
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: connected ? "var(--green)" : "var(--red)",
                boxShadow: connected ? "0 0 8px var(--green)" : "none",
              }}
            />
            <span style={{ color: "var(--text-dim)" }}>{connected ? "live" : noCreds ? "not connected" : "connecting…"}</span>
          </div>
        </header>

        {noCreds && (
          <div style={{ ...card, marginBottom: 20, borderColor: "var(--accent)", background: "var(--accent-dim)" }}>
            <strong>Connect to get started.</strong> Run <code className="mono">npm run --workspace apps/api seed:dev-tenant</code>{" "}
            in the repo, paste the printed API key above, and click Connect.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 20 }}>
          <div style={card}>
            <div style={label}>Total events ingested</div>
            <div className="mono" style={{ fontSize: 28, fontWeight: 600 }}>
              {snapshot?.activity.event_count ?? "—"}
            </div>
          </div>
          <div style={card}>
            <div style={label}>Active / recent workflows</div>
            <div className="mono" style={{ fontSize: 28, fontWeight: 600 }}>
              {snapshot?.workflows.length ?? "—"}
            </div>
          </div>
          <div style={card}>
            <div style={label}>Open dead letters</div>
            <div
              className="mono"
              style={{ fontSize: 28, fontWeight: 600, color: snapshot && snapshot.openDeadLetters > 0 ? "var(--amber)" : "var(--text)" }}
            >
              {snapshot?.openDeadLetters ?? "—"}
            </div>
          </div>
        </div>

        <div style={{ ...card, marginBottom: 20 }}>
          <div style={label}>Throughput — last 30 minutes</div>
          <Sparkline points={snapshot?.throughput ?? []} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, alignItems: "start" }}>
          <div style={card}>
            <div style={label}>Workflow executions</div>
            <WorkflowList workflows={snapshot?.workflows ?? []} />
          </div>
          <div style={card}>
            <div style={label}>Chaos panel</div>
            <ChaosPanel />
          </div>
        </div>

        <div style={{ ...card, marginTop: 14 }}>
          <div style={label}>Dead letters</div>
          <DeadLetterPanel refreshKey={tick * 1000 + (snapshot?.openDeadLetters ?? 0)} />
        </div>
      </div>
    </div>
  );
}
