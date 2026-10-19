import {
  allowsOverride,
  CLEAR_HOME_COOKIE,
  HOME_COOKIE,
  type HomeAddress,
  homeCookieHeader,
  matchesHome,
  parseIPv4,
  parseIPv6Prefix,
  readCookie,
  signHomeCookie,
  verifyHomeCookie,
} from './home';
import type { Visitor } from './visitor';

/** Lets local servers and PR previews issue cookies without a configured secret. */
const OVERRIDE_COOKIE_SECRET = 'local-and-pr-preview-only';

interface HomeAddressRow {
  ipv4: string;
  ipv6_prefix: string | null;
  reported_at: number;
}

export async function storedHomeAddress(db: D1Database): Promise<HomeAddress | null> {
  const row = await db
    .prepare('SELECT ipv4, ipv6_prefix, reported_at FROM home_address WHERE id = 1')
    .first<HomeAddressRow>();
  return row
    ? { ipv4: row.ipv4, ipv6Prefix: row.ipv6_prefix, reportedAt: row.reported_at }
    : null;
}

export interface ResolvedVisitor extends Visitor {
  /** A Set-Cookie value to send with the response, if any. */
  cookie?: string;
}

/**
 * Home is the house's fresh public address or a cookie issued from it. Every
 * request from the address refreshes the cookie.
 *
 * Where `allowsOverride`, `?as=home` simulates the address, `?as=away` a
 * mismatch that still honours the cookie, and `?as=outsider` drops the cookie.
 */
export async function resolveVisitor(
  request: Request,
  env: Pick<Env, 'DB' | 'HOME_COOKIE_SECRET'>,
  now = Date.now(),
): Promise<ResolvedVisitor> {
  const url = new URL(request.url);
  const override = allowsOverride(url) ? url.searchParams.get('as') : null;
  const secret =
    env.HOME_COOKIE_SECRET || (allowsOverride(url) ? OVERRIDE_COOKIE_SECRET : undefined);
  if (override === 'outsider') return { home: false, cookie: CLEAR_HOME_COOKIE };

  const atHome =
    override === 'home' ||
    (override !== 'away' &&
      matchesHome(
        request.headers.get('CF-Connecting-IP'),
        await storedHomeAddress(env.DB),
        now,
      ));
  if (atHome) {
    return {
      home: true,
      cookie: secret ? homeCookieHeader(await signHomeCookie(secret, now)) : undefined,
    };
  }
  const cookie = readCookie(request.headers.get('Cookie'), HOME_COOKIE);
  if (cookie === undefined || !secret) return { home: false };
  if (await verifyHomeCookie(secret, cookie, now)) return { home: true };
  // A tampered, expired or revoked cookie is cleared rather than resent forever.
  return { home: false, cookie: CLEAR_HOME_COOKIE };
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = (value: string) =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [x, y] = (await Promise.all([digest(a), digest(b)])).map(
    (hash) => new Uint8Array(hash),
  );
  // Fixed-length digests, compared without an early exit.
  let difference = 0;
  for (let i = 0; i < x!.length; i += 1) difference |= x![i]! ^ y![i]!;
  return difference === 0;
}

/** `POST /api/home/address` from Home Assistant. Absent without HOME_REPORT_TOKEN. */
export async function reportHomeAddress(
  request: Request,
  env: Pick<Env, 'DB' | 'HOME_REPORT_TOKEN'>,
  now = Date.now(),
): Promise<Response> {
  const token = env.HOME_REPORT_TOKEN;
  if (!token) return Response.json({ error: 'not found' }, { status: 404 });
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), token))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    ipv4?: unknown;
    ipv6_prefix?: unknown;
  } | null;
  const ipv4 = typeof body?.ipv4 === 'string' ? body.ipv4.trim() : '';
  const prefix =
    typeof body?.ipv6_prefix === 'string' && body.ipv6_prefix.trim()
      ? body.ipv6_prefix.trim()
      : null;
  if (!parseIPv4(ipv4)) {
    return Response.json(
      { error: 'ipv4 must be a dotted-quad address' },
      { status: 400 },
    );
  }
  if (prefix !== null && !parseIPv6Prefix(prefix)) {
    return Response.json(
      { error: 'ipv6_prefix must be an IPv6 network from /48 to /128' },
      { status: 400 },
    );
  }

  await env.DB.prepare(
    `INSERT INTO home_address (id, ipv4, ipv6_prefix, reported_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ipv4 = excluded.ipv4,
      ipv6_prefix = excluded.ipv6_prefix, reported_at = excluded.reported_at`,
  )
    .bind(ipv4, prefix, now)
    .run();
  return new Response(null, { status: 204 });
}
