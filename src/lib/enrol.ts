import { ENROL_TTL_S, isToken, randomToken, sha256 } from './home';

const WINDOW_MS = 10 * 60_000;
/** Codes one client may request per window, and all clients together. */
const START_LIMIT_PER_CLIENT = 5;
const START_LIMIT = 100;
/** Links Home Assistant may mint per window. */
const MINT_LIMIT = 10;
/**
 * Rejected confirmations per window, which only Home Assistant can send, and
 * rejected redemptions per client, which anyone can.
 */
const CONFIRM_FAILURE_LIMIT = 20;
const REDEEM_FAILURE_LIMIT = 10;
/** How long the browser that claimed a code may claim it again. */
const RECLAIM_MS = 60_000;
/** Codes and failures are kept a day for rate limiting, then pruned. */
const RETAIN_MS = 86_400_000;

export type Limited = { limited: true; retryAfter: number };

async function count(db: D1Database, sql: string, ...binds: unknown[]) {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function confirmFailuresExceeded(db: D1Database, now: number) {
  const failures = await count(
    db,
    "SELECT count(*) AS n FROM enrol_failures WHERE kind = 'confirm' AND at > ?",
    now - WINDOW_MS,
  );
  return failures >= CONFIRM_FAILURE_LIMIT;
}

async function redeemFailuresExceeded(db: D1Database, client: string, now: number) {
  const failures = await count(
    db,
    "SELECT count(*) AS n FROM enrol_failures WHERE kind = 'redeem' AND client_hash = ? AND at > ?",
    client,
    now - WINDOW_MS,
  );
  return failures >= REDEEM_FAILURE_LIMIT;
}

async function recordFailure(
  db: D1Database,
  kind: string,
  client: string | null,
  now: number,
) {
  await db
    .prepare('INSERT INTO enrol_failures (at, kind, client_hash) VALUES (?, ?, ?)')
    .bind(now, kind, client)
    .run();
}

const limited = (): Limited => ({ limited: true, retryAfter: WINDOW_MS / 1000 });

/** A code bound to the browser holding `nonce`, for Home Assistant to confirm. */
export async function startEnrolment(
  db: D1Database,
  client: string,
  now: number,
): Promise<{ code: string; nonce: string } | Limited> {
  await db.batch([
    db.prepare('DELETE FROM enrol_codes WHERE created_at < ?').bind(now - RETAIN_MS),
    db.prepare('DELETE FROM enrol_failures WHERE at < ?').bind(now - RETAIN_MS),
  ]);
  const code = randomToken();
  const nonce = randomToken();
  // One statement, so concurrent requests cannot all pass the quota check.
  const inserted = await db
    .prepare(
      `INSERT INTO enrol_codes (code_hash, kind, browser_hash, client_hash, created_at, expires_at)
      SELECT ?, 'browser', ?, ?, ?, ?
      WHERE (SELECT count(*) FROM enrol_codes
          WHERE kind = 'browser' AND created_at > ? AND client_hash = ?) < ?
        AND (SELECT count(*) FROM enrol_codes
          WHERE kind = 'browser' AND created_at > ?) < ?
      RETURNING code_hash`,
    )
    .bind(
      await sha256(code),
      await sha256(nonce),
      client,
      now,
      now + ENROL_TTL_S * 1000,
      now - WINDOW_MS,
      client,
      START_LIMIT_PER_CLIENT,
      now - WINDOW_MS,
      START_LIMIT,
    )
    .first();
  return inserted ? { code, nonce } : limited();
}

/** Home Assistant vouches for a browser code. True only the first time, before expiry. */
export async function confirmEnrolment(
  db: D1Database,
  code: unknown,
  now: number,
): Promise<boolean | Limited> {
  if (await confirmFailuresExceeded(db, now)) return limited();
  const confirmed =
    isToken(code) &&
    (await db
      .prepare(
        `UPDATE enrol_codes SET confirmed_at = ?
        WHERE code_hash = ? AND kind = 'browser' AND confirmed_at IS NULL
          AND consumed_at IS NULL AND expires_at > ?
        RETURNING code_hash`,
      )
      .bind(now, await sha256(code), now)
      .first()) !== null;
  if (!confirmed) await recordFailure(db, 'confirm', null, now);
  return confirmed;
}

/**
 * The pending browser's view of its code. A confirmed code is claimed here, by
 * the browser it was issued to, and nowhere else. That browser may claim it
 * again for a minute, so a response lost to a reload does not waste it.
 */
export async function claimEnrolment(
  db: D1Database,
  nonce: string,
  now: number,
): Promise<'home' | 'pending' | 'expired'> {
  const browser = await sha256(nonce);
  const claimed = await db
    .prepare(
      `UPDATE enrol_codes SET consumed_at = coalesce(consumed_at, ?)
      WHERE browser_hash = ? AND kind = 'browser' AND confirmed_at IS NOT NULL
        AND (consumed_at IS NULL OR consumed_at > ?) AND expires_at > ?
      RETURNING code_hash`,
    )
    .bind(now, browser, now - RECLAIM_MS, now)
    .first();
  if (claimed) return 'home';
  const pending = await count(
    db,
    `SELECT count(*) AS n FROM enrol_codes
    WHERE browser_hash = ? AND confirmed_at IS NULL AND expires_at > ?`,
    browser,
    now,
  );
  return pending ? 'pending' : 'expired';
}

/** A code for an enrolment link, redeemable once by whoever opens it. */
export async function mintEnrolLink(
  db: D1Database,
  now: number,
): Promise<{ code: string; expiresAt: number } | Limited> {
  const code = randomToken();
  const expiresAt = now + ENROL_TTL_S * 1000;
  const inserted = await db
    .prepare(
      `INSERT INTO enrol_codes (code_hash, kind, created_at, expires_at)
      SELECT ?, 'link', ?, ?
      WHERE (SELECT count(*) FROM enrol_codes
        WHERE kind = 'link' AND created_at > ?) < ?
      RETURNING code_hash`,
    )
    .bind(await sha256(code), now, expiresAt, now - WINDOW_MS, MINT_LIMIT)
    .first();
  return inserted ? { code, expiresAt } : limited();
}

export async function redeemEnrolLink(
  db: D1Database,
  code: unknown,
  client: string,
  now: number,
): Promise<boolean | Limited> {
  if (await redeemFailuresExceeded(db, client, now)) return limited();
  const redeemed =
    isToken(code) &&
    (await db
      .prepare(
        `UPDATE enrol_codes SET consumed_at = ?, client_hash = ?
        WHERE code_hash = ? AND kind = 'link' AND consumed_at IS NULL AND expires_at > ?
        RETURNING code_hash`,
      )
      .bind(now, client, await sha256(code), now)
      .first()) !== null;
  if (!redeemed) await recordFailure(db, 'redeem', client, now);
  return redeemed;
}
