"use client";

const STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  running: { bg: "var(--accent-dim)", fg: "var(--accent)", label: "running" },
  completed: { bg: "var(--green-dim)", fg: "var(--green)", label: "completed" },
  compensating: { bg: "var(--amber-dim)", fg: "var(--amber)", label: "compensating" },
  compensated: { bg: "var(--amber-dim)", fg: "var(--amber)", label: "compensated" },
  failed: { bg: "var(--red-dim)", fg: "var(--red)", label: "failed" },
};

export function StatusPill({ status }: { status: string }) {
  const s = STYLES[status] ?? { bg: "var(--panel-2)", fg: "var(--text-dim)", label: status };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: 0.2,
        background: s.bg,
        color: s.fg,
        textTransform: "uppercase",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: s.fg }} />
      {s.label}
    </span>
  );
}
