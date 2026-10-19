/** Home Assistant heartbeats every ~5 minutes; a quieter address may have been reassigned. */
export const HOME_ADDRESS_TTL_MS = 15 * 60_000;
export const HOME_COOKIE = '__Host-ldn-home';
export const HOME_COOKIE_MAX_AGE_S = 30 * 86_400;
/** Narrower than any household delegation, so a typo cannot admit a whole ISP. */
const MIN_IPV6_PREFIX = 48;

export interface HomeAddress {
  ipv4: string;
  ipv6Prefix: string | null;
  reportedAt: number;
}

export function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : NaN,
  );
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

/** Sixteen bytes, or null. Accepts `::` compression and an embedded IPv4 tail. */
export function parseIPv6(value: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(value) || value.split('::').length > 2) return null;
  const groups = (side: string) => (side === '' ? [] : side.split(':'));
  const [head, tail] = value.includes('::')
    ? [groups(value.split('::')[0]!), groups(value.split('::')[1]!)]
    : [groups(value), null];
  // Only the final group of the whole address may be an IPv4 tail.
  const words = (list: string[], last: boolean) => {
    const out: number[] = [];
    for (const [i, group] of list.entries()) {
      if (group.includes('.')) {
        const v4 = last && i === list.length - 1 ? parseIPv4(group) : null;
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(group)) {
        out.push(Number.parseInt(group, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const left = words(head, tail === null);
  const right = tail === null ? [] : words(tail, true);
  if (!left || !right) return null;
  if (tail === null && left.length !== 8) return null;
  if (tail !== null && left.length + right.length > 7) return null;
  const all = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return all.flatMap((word) => [word >> 8, word & 0xff]);
}

/** `2001:db8:1234:5600::/56` style; the bits past the length are ignored. */
export function parseIPv6Prefix(value: string): { bytes: number[]; bits: number } | null {
  const match = /^([^/]+)\/(\d{1,3})$/.exec(value);
  if (!match) return null;
  const bits = Number(match[2]);
  const bytes = parseIPv6(match[1]!);
  return bytes && bits >= MIN_IPV6_PREFIX && bits <= 128 ? { bytes, bits } : null;
}

function prefixMatches(address: number[], prefix: number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const mask = bits - bit >= 8 ? 0xff : (0xff << (8 - (bits - bit))) & 0xff;
    if ((address[bit / 8]! & mask) !== (prefix[bit / 8]! & mask)) return false;
  }
  return true;
}

export function isFresh(address: HomeAddress, now: number): boolean {
  const age = now - address.reportedAt;
  return age >= 0 && age <= HOME_ADDRESS_TTL_MS;
}

/** Whether a `CF-Connecting-IP` belongs to the house; false once the report is stale. */
export function matchesHome(
  ip: string | null,
  address: HomeAddress | null,
  now: number,
): boolean {
  if (!ip || !address || !isFresh(address, now)) return false;
  const home4 = parseIPv4(address.ipv4);
  const v4 = parseIPv4(ip);
  if (v4) return !!home4 && v4.every((byte, i) => byte === home4[i]);
  const v6 = parseIPv6(ip);
  if (!v6) return false;
  // An IPv4-mapped address is the IPv4 visitor in disguise.
  if (v6.slice(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    return !!home4 && v6.slice(12).every((byte, i) => byte === home4[i]);
  }
  const prefix = address.ipv6Prefix ? parseIPv6Prefix(address.ipv6Prefix) : null;
  return !!prefix && prefixMatches(v6, prefix.bytes, prefix.bits);
}

function base64url(bytes: ArrayBuffer): string {
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

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

const cookiePayload = (expires: number) => new TextEncoder().encode(`home.v1.${expires}`);

/** `v1.<expiry in epoch seconds>.<HMAC-SHA256>`; rotating the secret revokes them all. */
export async function signHomeCookie(secret: string, now: number): Promise<string> {
  const expires = Math.floor(now / 1000) + HOME_COOKIE_MAX_AGE_S;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    cookiePayload(expires),
  );
  return `v1.${expires}.${base64url(signature)}`;
}

export async function verifyHomeCookie(
  secret: string,
  value: string | undefined,
  now: number,
): Promise<boolean> {
  const match = value ? /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires * 1000 <= now) return false;
  const signature = fromBase64url(match[2]!);
  if (!signature) return false;
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    cookiePayload(expires),
  );
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export function homeCookieHeader(value: string): string {
  return `${HOME_COOKIE}=${value}; Max-Age=${HOME_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export const CLEAR_HOME_COOKIE = `${HOME_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

/**
 * Local servers and PR previews (`ldn-house-pr-N`, see scripts/preview) may
 * simulate the house with `?as=`. The production Worker never answers on these
 * hostnames, so the override cannot apply there.
 */
export function allowsOverride(url: URL): boolean {
  return (
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    /^ldn-house-pr-\d+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
  );
}
