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
  // Now tenant-scoped (Phase 09) — requires the same Authorization header
  // as every other route, so this visitor's chaos actions only ever
  // affect their own sandbox tenant's workflows.
  await fetch(`${getApiUrl()}/api/v1/_dev/chaos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

/**
 * Provisions a fresh, per-visitor sandbox tenant (Phase 09) and returns
 * its API key. Called once per browser — the returned key is then
 * persisted (setCredentials) so a returning visitor reuses their own
 * tenant instead of getting a new one every page load. Replaces the
 * Phase 05 shared-demo-tenant bootstrap as the dashboard's default:
 * every visitor's chaos actions and workflow traffic are now genuinely
 * isolated from every other visitor's, not just visually separated by
 * browser tab.
 */
export async function createSandboxTenant(): Promise<string | null> {
  try {
    const res = await fetch(`${getApiUrl()}/api/v1/demo/sandbox`, { method: "POST" });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.apiKey === "string" ? body.apiKey : null;
  } catch {
    return null;
  }
}

/**
 * Legacy shared demo tenant, kept for an old bookmarked link — no longer
 * what the dashboard calls by default (see createSandboxTenant).
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

export interface DeadLetter {
  id: string;
  source: string;
  attempts: number;
  last_error: string;
  created_at: string;
  replayed_at: string | null;
}

export async function fetchDeadLetters(): Promise<DeadLetter[]> {
  const { deadLetters } = await apiFetch<{ deadLetters: DeadLetter[] }>("/api/v1/dashboard/dead-letters");
  return deadLetters;
}

export async function replayDeadLetter(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${getApiUrl()}/api/v1/dead-letters/${id}/replay`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: body.message || body.error || `HTTP ${res.status}` };
    return { ok: true, message: "Replayed" };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

export async function sendDemoOrder(): Promise<void> {
  const id = `evt_ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await apiFetch("/api/v1/events", {
    method: "POST",
    body: JSON.stringify({ eventId: id, type: "order.created", payload: { orderId: id } }),
  });
}
