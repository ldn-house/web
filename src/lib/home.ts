export const HOME_COOKIE = '__Host-ldn-home';
export const HOME_COOKIE_MAX_AGE_S = 30 * 86_400;
/** A cookie is re-signed on use once it is a day old, so it lapses after 30 idle days. */
const HOME_COOKIE_REFRESH_S = 86_400;
export const ENROL_COOKIE = '__Host-ldn-enrol';
export const ENROL_TTL_S = 10 * 60;

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return new Uint8Array(Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** 128 random bits, URL-safe. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);

export async function sha256(value: string): Promise<string> {
  return base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Keyed, so stored client hashes cannot be reversed by enumerating addresses. */
export async function clientHash(secret: string, ip: string | null): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(`client.${ip ?? ''}`),
  );
  return base64url(mac);
}

/** Purpose-separated `v1.<fields…>.<expiry s>.<HMAC-SHA256>`. */
async function signToken(
  secret: string,
  purpose: string,
  fields: string[],
  expires: number,
): Promise<string> {
  const body = ['v1', ...fields, String(expires)].join('.');
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(`${purpose}.${body}`),
  );
  return `${body}.${base64url(mac)}`;
}

/** The signed fields and expiry, or null if forged, malformed or expired. */
async function verifyToken(
  secret: string,
  purpose: string,
  fieldCount: number,
  value: string | undefined,
  now: number,
): Promise<{ fields: string[]; expires: number } | null> {
  const parts = value?.split('.') ?? [];
  if (parts.length !== fieldCount + 3 || parts[0] !== 'v1') return null;
  const expiresText = parts.at(-2)!;
  const mac = parts.at(-1)!;
  if (!/^\d{1,12}$/.test(expiresText) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const fields = parts.slice(1, -2);
  if (!fields.every((field) => /^[A-Za-z0-9_-]+$/.test(field))) return null;
  const expires = Number(expiresText);
  if (expires * 1000 <= now) return null;
  const signature = fromBase64url(mac);
  if (!signature) return null;
  const body = parts.slice(0, -1).join('.');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    new TextEncoder().encode(`${purpose}.${body}`),
  );
  return valid ? { fields, expires } : null;
}

/** `v1.<expiry in epoch seconds>.<HMAC>`; rotating the secret revokes them all. */
export function signHomeCookie(secret: string, now: number): Promise<string> {
  return signToken(secret, 'home', [], Math.floor(now / 1000) + HOME_COOKIE_MAX_AGE_S);
}

/** Whether the cookie admits its holder, and whether it is due to be re-signed. */
export async function verifyHomeCookie(
  secret: string,
  value: string | undefined,
  now: number,
): Promise<{ valid: boolean; refresh: boolean }> {
  const token = await verifyToken(secret, 'home', 0, value, now);
  if (!token) return { valid: false, refresh: false };
  const issued = token.expires - HOME_COOKIE_MAX_AGE_S;
  return { valid: true, refresh: now / 1000 - issued >= HOME_COOKIE_REFRESH_S };
}

/** Binds a pending enrolment to this browser: `v1.<nonce>.<expiry>.<HMAC>`. */
export function signEnrolCookie(secret: string, nonce: string, now: number) {
  return signToken(secret, 'enrol', [nonce], Math.floor(now / 1000) + ENROL_TTL_S);
}

export async function verifyEnrolCookie(
  secret: string,
  value: string | undefined,
  now: number,
): Promise<string | null> {
  const token = await verifyToken(secret, 'enrol', 1, value, now);
  return token && isToken(token.fields[0]) ? token.fields[0] : null;
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

const cookieHeader = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const homeCookieHeader = (value: string) =>
  cookieHeader(HOME_COOKIE, value, HOME_COOKIE_MAX_AGE_S);
export const CLEAR_HOME_COOKIE = cookieHeader(HOME_COOKIE, '', 0);
export const enrolCookieHeader = (value: string) =>
  cookieHeader(ENROL_COOKIE, value, ENROL_TTL_S);
export const CLEAR_ENROL_COOKIE = cookieHeader(ENROL_COOKIE, '', 0);

/** Cookie-authenticated writes must come from this site's own pages. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  return (
    origin === new URL(request.url).origin && (site === null || site === 'same-origin')
  );
}

/**
 * Local servers and PR previews (`ldn-house-pr-N`, see scripts/preview) may
 * simulate visitors with `?as=`. The production Worker never answers on these
 * hostnames, so the override cannot apply there.
 */
export function allowsOverride(url: URL): boolean {
  return (
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    /^ldn-house-pr-\d+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
  );
}
