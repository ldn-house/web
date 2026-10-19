import { describe, expect, it } from 'vitest';
import {
  allowsOverride,
  HOME_ADDRESS_TTL_MS,
  HOME_COOKIE_MAX_AGE_S,
  type HomeAddress,
  matchesHome,
  parseIPv4,
  parseIPv6,
  parseIPv6Prefix,
  readCookie,
  signHomeCookie,
  verifyHomeCookie,
} from './home';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const home = (overrides: Partial<HomeAddress> = {}): HomeAddress => ({
  ipv4: '192.0.2.10',
  ipv6Prefix: null,
  reportedAt: NOW - 60_000,
  ...overrides,
});

describe('address parsing', () => {
  it('accepts dotted quads only', () => {
    expect(parseIPv4('192.0.2.10')).toEqual([192, 0, 2, 10]);
    for (const bad of [
      '192.0.2',
      '192.0.2.256',
      '192.0.2.010',
      '192.0.2.x',
      '',
      ' 192.0.2.1',
    ]) {
      expect(parseIPv4(bad)).toBeNull();
    }
  });

  it('expands compressed and IPv4-tailed IPv6', () => {
    expect(parseIPv6('2001:db8::1')).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseIPv6('::ffff:192.0.2.10')?.slice(10)).toEqual([
      0xff, 0xff, 192, 0, 2, 10,
    ]);
    expect(parseIPv6('2001:db8:0:0:0:0:0:1')).toEqual(parseIPv6('2001:db8::1'));
    for (const bad of [
      '2001:db8::1::2',
      '2001:db8:1',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7::8',
      '192.0.2.1::',
      '2001:db8::g',
      'fe80::1%eth0',
    ]) {
      expect(parseIPv6(bad)).toBeNull();
    }
  });

  it('refuses prefixes broad enough to cover other households', () => {
    expect(parseIPv6Prefix('2001:db8:1200::/56')?.bits).toBe(56);
    expect(parseIPv6Prefix('2001:db8:1200::/48')?.bits).toBe(48);
    expect(parseIPv6Prefix('2001:db8::/32')).toBeNull();
    expect(parseIPv6Prefix('::/0')).toBeNull();
    expect(parseIPv6Prefix('2001:db8::/129')).toBeNull();
    expect(parseIPv6Prefix('2001:db8::')).toBeNull();
  });
});

describe('matchesHome', () => {
  it('matches the reported IPv4 address exactly', () => {
    expect(matchesHome('192.0.2.10', home(), NOW)).toBe(true);
    expect(matchesHome('192.0.2.11', home(), NOW)).toBe(false);
    expect(matchesHome('198.51.100.10', home(), NOW)).toBe(false);
    expect(matchesHome('::ffff:192.0.2.10', home(), NOW)).toBe(true);
  });

  it('matches IPv6 visitors inside the reported prefix only', () => {
    const v6 = home({ ipv6Prefix: '2001:db8:1200::/56' });
    expect(matchesHome('2001:db8:1200::1', v6, NOW)).toBe(true);
    expect(matchesHome('2001:db8:1200:ff:aaaa::1', v6, NOW)).toBe(true);
    expect(matchesHome('2001:db8:1201::1', v6, NOW)).toBe(false);
    expect(matchesHome('2001:db8:1300::1', v6, NOW)).toBe(false);

    const odd = home({ ipv6Prefix: '2001:db8:1200:80::/57' });
    expect(matchesHome('2001:db8:1200:ff::1', odd, NOW)).toBe(true);
    expect(matchesHome('2001:db8:1200:7f::1', odd, NOW)).toBe(false);

    const slash64 = home({ ipv6Prefix: '2001:db8:1200:5::/64' });
    expect(matchesHome('2001:db8:1200:5:abcd::9', slash64, NOW)).toBe(true);
    expect(matchesHome('2001:db8:1200:6::1', slash64, NOW)).toBe(false);
  });

  it('never matches IPv6 without a reported prefix', () => {
    expect(matchesHome('2001:db8:1200::1', home(), NOW)).toBe(false);
    expect(matchesHome('::', home(), NOW)).toBe(false);
  });

  it('rejects missing or malformed visitor addresses', () => {
    expect(matchesHome(null, home(), NOW)).toBe(false);
    expect(matchesHome('', home(), NOW)).toBe(false);
    expect(matchesHome('not an address', home(), NOW)).toBe(false);
    expect(matchesHome('192.0.2.10', null, NOW)).toBe(false);
  });

  it('stops trusting an address once its heartbeat goes quiet', () => {
    const at = (age: number) => home({ reportedAt: NOW - age });
    expect(matchesHome('192.0.2.10', at(HOME_ADDRESS_TTL_MS), NOW)).toBe(true);
    expect(matchesHome('192.0.2.10', at(HOME_ADDRESS_TTL_MS + 1), NOW)).toBe(false);
    // A report from the future is a clock fault, not a fresh address.
    expect(matchesHome('192.0.2.10', at(-60_000), NOW)).toBe(false);
  });
});

describe('home cookie', () => {
  const SECRET = 'synthetic-cookie-secret';

  it('verifies a cookie it signed, until it expires', async () => {
    const cookie = await signHomeCookie(SECRET, NOW);
    expect(cookie).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyHomeCookie(SECRET, cookie, NOW)).toBe(true);
    const expiry = NOW + HOME_COOKIE_MAX_AGE_S * 1000;
    expect(await verifyHomeCookie(SECRET, cookie, expiry - 1000)).toBe(true);
    expect(await verifyHomeCookie(SECRET, cookie, expiry)).toBe(false);
  });

  it('rejects tampering and a rotated secret', async () => {
    const cookie = await signHomeCookie(SECRET, NOW);
    const [version, expires, signature] = cookie.split('.') as [string, string, string];
    // The final character partly encodes padding bits, so change the first.
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    for (const forged of [
      `${version}.${expires}.${flipped}`,
      `${version}.${Number(expires) + 86_400}.${signature}`,
      `v2.${expires}.${signature}`,
      `${version}.${expires}`,
      '',
      'v1.99999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      expect(await verifyHomeCookie(SECRET, forged, NOW)).toBe(false);
    }
    expect(await verifyHomeCookie('rotated-secret', cookie, NOW)).toBe(false);
    expect(await verifyHomeCookie(SECRET, undefined, NOW)).toBe(false);
  });

  it('reads one cookie out of a header', () => {
    expect(readCookie('a=1; __Host-ldn-home=v1.2.x; b=3', '__Host-ldn-home')).toBe(
      'v1.2.x',
    );
    expect(readCookie('x__Host-ldn-home=1', '__Host-ldn-home')).toBeUndefined();
    expect(readCookie(null, '__Host-ldn-home')).toBeUndefined();
  });
});

describe('allowsOverride', () => {
  it('only allows local servers and PR previews', () => {
    const allowed = (url: string) => allowsOverride(new URL(url));
    expect(allowed('http://localhost:5173/')).toBe(true);
    expect(allowed('http://127.0.0.1:4173/')).toBe(true);
    expect(allowed('https://ldn-house-pr-25.example.workers.dev/')).toBe(true);
    expect(allowed('https://ldn.house/')).toBe(false);
    expect(allowed('https://preview.ldn.house/')).toBe(false);
    expect(allowed('https://ldn-house.example.workers.dev/')).toBe(false);
    expect(allowed('https://ldn-house-pr-25.example.workers.dev.attacker.test/')).toBe(
      false,
    );
    expect(allowed('https://localhost.attacker.test/')).toBe(false);
  });
});
