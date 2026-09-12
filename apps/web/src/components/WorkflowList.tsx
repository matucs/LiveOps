"use client";

import { StatusPill } from "./StatusPill";

export interface WorkflowSummary {
  execution_id: string;
  definition: string;
  status: string;
  current_step: number;
  step_count: number;
  correlation_id: string;
  error: string | null;
  updated_at: string;
}

function StepDots({ current, total, status }: { current: number; total: number; status: string }) {
  const dots = Array.from({ length: total }, (_, i) => i);
  const failing = status === "compensating" || status === "compensated" || status === "failed";
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {dots.map((i) => {
        let color = "var(--border)";
        if (i < current) color = failing ? "var(--amber)" : "var(--green)";
        else if (i === current && status === "running") color = "var(--accent)";
        return <span key={i} style={{ width: 7, height: 7, borderRadius: 999, background: color }} />;
      })}
    </div>
  );
}

export function WorkflowList({ workflows }: { workflows: WorkflowSummary[] }) {
  if (workflows.length === 0) {
    return <div style={{ color: "var(--text-faint)", fontSize: 13, padding: "20px 0" }}>No workflow executions yet.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {workflows.map((w) => (
        <div
          key={w.execution_id}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto",
            alignItems: "center",
            gap: 14,
            padding: "10px 4px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {w.definition} <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400 }}>· {w.correlation_id}</span>
            </div>
            {w.error && (
              <div style={{ fontSize: 12, color: "var(--red)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {w.error}
              </div>
            )}
          </div>
          <StepDots current={w.current_step} total={w.step_count} status={w.status} />
          <StatusPill status={w.status} />
        </div>
      ))}
    </div>
  );
}
