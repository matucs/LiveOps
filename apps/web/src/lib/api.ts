"use client";

const DEFAULT_API_URL = "http://localhost:3000";

export function getApiUrl(): string {
  if (typeof window === "undefined") return DEFAULT_API_URL;
  return localStorage.getItem("liveops_api_url") || DEFAULT_API_URL;
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

export async function sendDemoOrder(): Promise<void> {
  const id = `evt_ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await apiFetch("/api/v1/events", {
    method: "POST",
    body: JSON.stringify({ eventId: id, type: "order.created", payload: { orderId: id } }),
  });
}
