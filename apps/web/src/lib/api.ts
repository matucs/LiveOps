"use client";

// In production this is built empty ("") so every request is a relative
// path on the same origin — Caddy reverse-proxies /api/* to the API
// container, so the browser never needs CORS at all. Local dev keeps
// using two separate ports (localhost:3000/3001), which is why the API
// still carries CORS support for that case (see apps/api's WEB_ORIGINS).
const DEFAULT_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export function getApiUrl(): string {
  if (typeof window === "undefined") return DEFAULT_API_URL;
  // A same-origin default ("") is a deliberate, valid override — only
  // fall back to localhost when nothing has been stored at all.
  const stored = localStorage.getItem("liveops_api_url");
  return stored !== null ? stored : DEFAULT_API_URL;
}

export function getApiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("liveops_api_key") || "";
}

export function setCredentials(apiUrl: string, apiKey: string): void {
  localStorage.setItem("liveops_api_url", apiUrl);
  localStorage.setItem("liveops_api_key", apiKey);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function triggerChaos(action: string): Promise<void> {
  await fetch(`${getApiUrl()}/api/v1/_dev/chaos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

/**
 * Fetches the public demo tenant's API key, if the deployment has one
 * configured (DEMO_API_KEY on the server). Lets a visitor open the live
 * URL and see real data immediately, with no seed script to run — the
 * key is scoped to one demo tenant seeded at deploy time, not a
 * privileged credential.
 */
export async function fetchDemoKey(): Promise<string | null> {
  try {
    const res = await fetch(`${getApiUrl()}/api/v1/demo/bootstrap`);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.apiKey === "string" ? body.apiKey : null;
  } catch {
    return null;
  }
}

export async function sendDemoOrder(): Promise<void> {
  const id = `evt_ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await apiFetch("/api/v1/events", {
    method: "POST",
    body: JSON.stringify({ eventId: id, type: "order.created", payload: { orderId: id } }),
  });
}
