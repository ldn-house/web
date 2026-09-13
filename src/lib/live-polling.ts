// Each upstream refresh asks for two telemetry fields: 60 calls/hour at most.
export const LIVE_REFRESH_MS = 120_000;
export const LIVE_READING_MAX_AGE_MS = 300_000;

/** Retry-After accepts either seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}
