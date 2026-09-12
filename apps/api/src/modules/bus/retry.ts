/**
 * Exponential backoff with full jitter (AWS-style: random in [0, cap]).
 * Full jitter avoids thundering-herd retries when many messages fail at
 * once, at the cost of retry timing being less predictable — an accepted
 * trade-off for a background consumer loop with no human waiting on it.
 */
export function backoffMs(attempt: number, baseMs = 200, capMs = 10_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
