"use client";

import { useState } from "react";
import { getApiUrl, getApiKey, setCredentials } from "@/lib/api";

export function ConnectionBar({ onSaved }: { onSaved: () => void }) {
  const [apiUrl, setApiUrl] = useState(getApiUrl());
  const [apiKey, setApiKey] = useState(getApiKey());

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "10px 16px",
        background: "var(--panel)",
        borderBottom: "1px solid var(--border)",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-faint)" }}>API URL</span>
      <input
        value={apiUrl}
        onChange={(e) => setApiUrl(e.target.value)}
        style={inputStyle}
        placeholder="http://localhost:3000"
      />
      <span style={{ fontSize: 12, color: "var(--text-faint)" }}>API key</span>
      <input
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        style={{ ...inputStyle, minWidth: 260 }}
        placeholder="lo_… (from npm run seed:dev-tenant)"
        type="password"
      />
      <button
        style={{
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--accent)",
          background: "var(--accent-dim)",
          color: "var(--accent)",
          fontSize: 12.5,
          fontWeight: 600,
        }}
        onClick={() => {
          setCredentials(apiUrl, apiKey);
          onSaved();
        }}
      >
        Connect
      </button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "6px 10px",
  fontSize: 12.5,
  fontFamily: "var(--font-mono)",
  minWidth: 200,
};
