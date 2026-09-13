"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchDeadLetters, replayDeadLetter, type DeadLetter } from "@/lib/api";

export function DeadLetterPanel({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<DeadLetter[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchDeadLetters().then(setItems).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function replay(id: string) {
    setBusyId(id);
    const result = await replayDeadLetter(id);
    setNotice(result.ok ? `Replayed dead letter #${id}` : `#${id}: ${result.message}`);
    setBusyId(null);
    load();
  }

  const open = items.filter((d) => !d.replayed_at);

  if (open.length === 0) {
    return <div style={{ color: "var(--text-faint)", fontSize: 13, padding: "12px 0" }}>No open dead letters.</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 260, overflowY: "auto" }}>
        {open.map((d) => (
          <div
            key={d.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 10,
              alignItems: "center",
              padding: "9px 4px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--text-dim)" }}>
                #{d.id} · {d.source} · {d.attempts} attempts
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--red)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  marginTop: 2,
                }}
                title={d.last_error}
              >
                {d.last_error}
              </div>
            </div>
            <button
              onClick={() => replay(d.id)}
              disabled={busyId !== null}
              style={{
                padding: "5px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent-dim)",
                color: "var(--accent)",
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {busyId === d.id ? "…" : "Replay"}
            </button>
          </div>
        ))}
      </div>
      {notice && <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 8 }}>{notice}</div>}
    </div>
  );
}
