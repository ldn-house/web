import { LIVE_READING_MAX_AGE_MS, LIVE_REFRESH_MS } from './live-polling';
import { type Fetcher, fetchLiveDemand, type LiveDemand, OctopusError } from './octopus';

interface CachedPower {
  reading: string | null;
  next_fetch_at: number;
  lease_token: string | null;
}

function responseFor(row: CachedPower, now: number): Response {
  const reading = row.reading ? (JSON.parse(row.reading) as LiveDemand) : null;
  const age = reading ? now - Date.parse(reading.readAt) : Infinity;
  const usable = reading && age >= 0 && age < LIVE_READING_MAX_AGE_MS;
  const retry = row.lease_token
    ? 5
    : Math.max(1, Math.ceil((row.next_fetch_at - now) / 1000));
  return Response.json(usable ? reading : { error: 'live power unavailable' }, {
    status: usable ? 200 : 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': String(retry) },
  });
}

/** D1 coordinates the quota across Worker isolates and data centres. */
export async function livePowerResponse(
  db: D1Database,
  apiKey: string,
  options: { now?: () => number; fetchImpl?: Fetcher } = {},
): Promise<Response> {
  const clock = options.now ?? Date.now;
  if (!apiKey)
    return responseFor(
      { reading: null, next_fetch_at: clock() + LIVE_REFRESH_MS, lease_token: null },
      clock(),
    );
  const now = clock();
  const lease = crypto.randomUUID();
  // The conditional upsert is atomic: only one request can win each refresh.
  // Reserving the whole interval also bounds retries if that Worker disappears.
  const claimed = await db
    .prepare(`
    INSERT INTO live_power_cache (id, next_fetch_at, lease_token) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET next_fetch_at = excluded.next_fetch_at,
      lease_token = excluded.lease_token
    WHERE live_power_cache.next_fetch_at <= ?
    RETURNING reading, next_fetch_at, lease_token
  `)
    .bind(now + LIVE_REFRESH_MS, lease, now)
    .first<CachedPower>();
  if (!claimed) {
    const cached = await db
      .prepare(
        'SELECT reading, next_fetch_at, lease_token FROM live_power_cache WHERE id = 1',
      )
      .first<CachedPower>();
    return responseFor(cached!, clock());
  }

  let reading = claimed.reading;
  let nextFetchAt = now + LIVE_REFRESH_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const fetchImpl: Fetcher = (input, init) =>
    (options.fetchImpl ?? fetch)(input, { ...init, signal: controller.signal });
  try {
    const latest = await fetchLiveDemand(apiKey, new Date(now), fetchImpl);
    if (latest) reading = JSON.stringify(latest);
  } catch (error) {
    if (error instanceof OctopusError && error.rateLimited) {
      nextFetchAt = Math.max(
        nextFetchAt,
        clock() + (error.retryAfterSeconds ?? 3600) * 1000,
      );
      console.warn(
        'Octopus live readings paused until',
        new Date(nextFetchAt).toISOString(),
      );
    } else {
      // Keep normal failure retries bounded too, without repeating an upstream stack trace.
      console.warn(
        'Octopus live readings unavailable; retrying after the refresh interval',
      );
    }
  } finally {
    clearTimeout(timeout);
  }
  // A late response must never overwrite a newer lease or its cooldown.
  await db
    .prepare(`UPDATE live_power_cache SET reading = ?, next_fetch_at = ?, lease_token = NULL
    WHERE id = 1 AND lease_token = ?`)
    .bind(reading, nextFetchAt, lease)
    .run();
  const cached = await db
    .prepare(
      'SELECT reading, next_fetch_at, lease_token FROM live_power_cache WHERE id = 1',
    )
    .first<CachedPower>();
  return responseFor(cached!, clock());
}
