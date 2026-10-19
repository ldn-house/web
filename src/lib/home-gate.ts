import {
  claimEnrolment,
  confirmEnrolment,
  type Limited,
  mintEnrolLink,
  redeemEnrolLink,
  startEnrolment,
} from './enrol';
import {
  allowsOverride,
  CLEAR_ENROL_COOKIE,
  CLEAR_HOME_COOKIE,
  clientHash,
  ENROL_COOKIE,
  enrolCookieHeader,
  HOME_COOKIE,
  homeCookieHeader,
  isSameOrigin,
  readCookie,
  signEnrolCookie,
  signHomeCookie,
  verifyEnrolCookie,
  verifyHomeCookie,
} from './home';
import type { Visitor } from './visitor';

type HomeEnv = Pick<
  Env,
  'DB' | 'HOME_COOKIE_SECRET' | 'HOME_ASSISTANT_TOKEN' | 'HOME_ASSISTANT_WEBHOOK_URL'
>;

/** Lets local servers and PR previews issue cookies without a configured secret. */
const OVERRIDE_COOKIE_SECRET = 'local-and-pr-preview-only';

function cookieSecret(env: HomeEnv, url: URL): string | undefined {
  return (
    env.HOME_COOKIE_SECRET || (allowsOverride(url) ? OVERRIDE_COOKIE_SECRET : undefined)
  );
}

export interface ResolvedVisitor extends Visitor {
  /** A Set-Cookie value to send with the response, if any. */
  cookie?: string;
}

/**
 * Home is a valid home cookie, re-signed on use once a day old. Where
 * `allowsOverride`, `?as=home` issues one and `?as=outsider` drops it.
 */
export async function resolveVisitor(
  request: Request,
  env: HomeEnv,
  now = Date.now(),
): Promise<ResolvedVisitor> {
  const url = new URL(request.url);
  const override = allowsOverride(url) ? url.searchParams.get('as') : null;
  const secret = cookieSecret(env, url);
  if (override === 'outsider') return { home: false, cookie: CLEAR_HOME_COOKIE };
  if (override === 'home' && secret) {
    return { home: true, cookie: homeCookieHeader(await signHomeCookie(secret, now)) };
  }
  const cookie = readCookie(request.headers.get('Cookie'), HOME_COOKIE);
  if (cookie === undefined || !secret) return { home: false };
  const { valid, refresh } = await verifyHomeCookie(secret, cookie, now);
  if (!valid) return { home: false, cookie: CLEAR_HOME_COOKIE };
  return {
    home: true,
    cookie: refresh ? homeCookieHeader(await signHomeCookie(secret, now)) : undefined,
  };
}

function json(body: unknown, status: number, init: HeadersInit = {}) {
  const headers = new Headers(init);
  headers.set('Cache-Control', 'no-store');
  return Response.json(body, { status, headers });
}

const tooMany = (limit: Limited) =>
  json({ error: 'too many requests' }, 429, { 'Retry-After': String(limit.retryAfter) });

const isLimited = (value: unknown): value is Limited =>
  typeof value === 'object' && value !== null && 'limited' in value;

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

/** Home Assistant's calls carry HOME_ASSISTANT_TOKEN; without it the routes 404. */
async function homeAssistant(request: Request, env: HomeEnv): Promise<Response | null> {
  const token = env.HOME_ASSISTANT_TOKEN;
  if (!token) return json({ error: 'not found' }, 404);
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), token))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

function webhookUrl(env: HomeEnv, code: string): string | null {
  try {
    const url = new URL(env.HOME_ASSISTANT_WEBHOOK_URL ?? '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.searchParams.set('code', code);
    return url.toString();
  } catch {
    return null;
  }
}

/** `POST /api/enrol/start`: a code for Home Assistant, bound to this browser. */
export async function startBrowserEnrolment(
  request: Request,
  env: HomeEnv,
  now = Date.now(),
): Promise<Response> {
  if (!isSameOrigin(request)) return json({ error: 'forbidden' }, 403);
  const secret = cookieSecret(env, new URL(request.url));
  if (!secret || !webhookUrl(env, 'x')) {
    return json({ error: 'enrolment is not set up' }, 503);
  }
  const client = await clientHash(secret, request.headers.get('CF-Connecting-IP'));
  const started = await startEnrolment(env.DB, client, now);
  if (isLimited(started)) return tooMany(started);
  return json({ confirmUrl: webhookUrl(env, started.code) }, 201, {
    'Set-Cookie': enrolCookieHeader(await signEnrolCookie(secret, started.nonce, now)),
  });
}

/** `POST /api/enrol/status`: claims a confirmed code for the browser it was issued to. */
export async function browserEnrolmentStatus(
  request: Request,
  env: HomeEnv,
  now = Date.now(),
): Promise<Response> {
  if (!isSameOrigin(request)) return json({ error: 'forbidden' }, 403);
  const secret = cookieSecret(env, new URL(request.url));
  const nonce = secret
    ? await verifyEnrolCookie(
        secret,
        readCookie(request.headers.get('Cookie'), ENROL_COOKIE),
        now,
      )
    : null;
  if (!secret || !nonce) return json({ state: 'expired' }, 200);
  const state = await claimEnrolment(env.DB, nonce, now);
  if (state === 'pending') return json({ state }, 200);
  const headers = new Headers({ 'Set-Cookie': CLEAR_ENROL_COOKIE });
  if (state === 'home') {
    headers.append('Set-Cookie', homeCookieHeader(await signHomeCookie(secret, now)));
  }
  return json({ state }, 200, headers);
}

/** `POST /api/home/confirm` from Home Assistant's local-only webhook. */
export async function confirmBrowserEnrolment(
  request: Request,
  env: HomeEnv,
  now = Date.now(),
): Promise<Response> {
  const denied = await homeAssistant(request, env);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const confirmed = await confirmEnrolment(env.DB, body?.code, now);
  if (isLimited(confirmed)) return tooMany(confirmed);
  return confirmed
    ? new Response(null, { status: 204 })
    : json({ error: 'unknown, expired or used code' }, 404);
}

/** `POST /api/home/codes` from Home Assistant: a one-time enrolment link. */
export async function mintEnrolmentLink(
  request: Request,
  env: HomeEnv,
  now = Date.now(),
): Promise<Response> {
  const denied = await homeAssistant(request, env);
  if (denied) return denied;
  const minted = await mintEnrolLink(env.DB, now);
  if (isLimited(minted)) return tooMany(minted);
  const url = new URL('/enrol', request.url);
  url.searchParams.set('code', minted.code);
  return json(
    { url: url.toString(), expiresAt: new Date(minted.expiresAt).toISOString() },
    201,
  );
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

function page(body: string, status = 200, headers: HeadersInit = {}) {
  return new Response(
    `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>ldn.house</title>
<style>body{margin:0;background:#0d1015;color:#e5e5e5;font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;margin:4rem auto;padding:0 1.5rem}h1{font-size:1.5rem}
p{color:#a3a3a3}button,a{font:inherit;color:#0d1015;background:#e5e5e5;border:0;
border-radius:.5rem;padding:.6rem 1rem;text-decoration:none;cursor:pointer}</style>
</head><body><main><h1>ldn.house</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex',
        ...headers,
      },
    },
  );
}

/**
 * `/enrol?code=` from Home Assistant's link. Opening it only shows a button, so
 * link previews cannot spend the code; the same-origin POST redeems it.
 */
export async function enrolmentLinkPage(
  request: Request,
  env: HomeEnv,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const secret = cookieSecret(env, url);
  if (request.method === 'GET') {
    const code = url.searchParams.get('code') ?? '';
    return page(`<p>Show live usage on this device for the next 30 days.</p>
<form method="post" action="/enrol"><input type="hidden" name="code" value="${escapeHtml(code)}">
<button type="submit">Enrol this device</button></form>`);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (!isSameOrigin(request)) return page('<p>Open the link again to enrol.</p>', 403);
  if (!secret) return page('<p>Enrolment is not set up.</p>', 503);
  const form = await request.formData().catch(() => null);
  const client = await clientHash(secret, request.headers.get('CF-Connecting-IP'));
  const redeemed = await redeemEnrolLink(env.DB, form?.get('code'), client, now);
  if (isLimited(redeemed)) {
    return page('<p>Too many attempts. Try again later.</p>', 429, {
      'Retry-After': String(redeemed.retryAfter),
    });
  }
  if (!redeemed) {
    return page(
      '<p>This link has expired or was already used. Ask Home Assistant for a new one.</p>',
      410,
    );
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/',
      'Cache-Control': 'no-store',
      'Set-Cookie': homeCookieHeader(await signHomeCookie(secret, now)),
    },
  });
}
