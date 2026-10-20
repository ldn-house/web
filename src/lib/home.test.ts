import { describe, expect, it } from 'vitest';
import {
  allowsOverride,
  ENROL_TTL_S,
  HOME_COOKIE_MAX_AGE_S,
  isSameOrigin,
  isToken,
  randomToken,
  readCookie,
  signEnrolCookie,
  signHomeCookie,
  verifyEnrolCookie,
  verifyHomeCookie,
} from './home';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const SECRET = 'synthetic-cookie-secret';

/** Changes a character that carries signature bits; the last partly encodes padding. */
const tamper = (value: string) => {
  const at = value.lastIndexOf('.') + 1;
  return `${value.slice(0, at)}${value[at] === 'A' ? 'B' : 'A'}${value.slice(at + 1)}`;
};

describe('home cookie', () => {
  it('verifies a cookie it signed, until it expires', async () => {
    const cookie = await signHomeCookie(SECRET, NOW);
    expect(cookie).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect((await verifyHomeCookie(SECRET, cookie, NOW)).valid).toBe(true);
    const expiry = NOW + HOME_COOKIE_MAX_AGE_S * 1000;
    expect((await verifyHomeCookie(SECRET, cookie, expiry - 1000)).valid).toBe(true);
    expect((await verifyHomeCookie(SECRET, cookie, expiry)).valid).toBe(false);
  });

  it('asks to be re-signed once a day old', async () => {
    const cookie = await signHomeCookie(SECRET, NOW);
    expect(await verifyHomeCookie(SECRET, cookie, NOW + 3_600_000)).toEqual({
      valid: true,
      refresh: false,
    });
    expect(await verifyHomeCookie(SECRET, cookie, NOW + 86_400_000)).toEqual({
      valid: true,
      refresh: true,
    });
  });

  it('rejects tampering and a rotated secret', async () => {
    const cookie = await signHomeCookie(SECRET, NOW);
    const [version, expires, signature] = cookie.split('.') as [string, string, string];
    for (const forged of [
      tamper(cookie),
      `${version}.${Number(expires) + 86_400}.${signature}`,
      `v2.${expires}.${signature}`,
      `${version}.${expires}`,
      '',
      'v1.99999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      expect((await verifyHomeCookie(SECRET, forged, NOW)).valid).toBe(false);
    }
    expect((await verifyHomeCookie('rotated-secret', cookie, NOW)).valid).toBe(false);
    expect((await verifyHomeCookie(SECRET, undefined, NOW)).valid).toBe(false);
  });
});

describe('enrolment cookie', () => {
  it('carries its nonce for ten minutes', async () => {
    const nonce = randomToken();
    const cookie = await signEnrolCookie(SECRET, nonce, NOW);
    expect(await verifyEnrolCookie(SECRET, cookie, NOW)).toBe(nonce);
    expect(await verifyEnrolCookie(SECRET, cookie, NOW + ENROL_TTL_S * 1000)).toBeNull();
    expect(await verifyEnrolCookie(SECRET, tamper(cookie), NOW)).toBeNull();
    expect(await verifyEnrolCookie('rotated-secret', cookie, NOW)).toBeNull();
  });

  it('cannot stand in for a home cookie, or the other way round', async () => {
    const enrol = await signEnrolCookie(SECRET, randomToken(), NOW);
    const home = await signHomeCookie(SECRET, NOW);
    expect((await verifyHomeCookie(SECRET, enrol, NOW)).valid).toBe(false);
    expect(await verifyEnrolCookie(SECRET, home, NOW)).toBeNull();
    // Same shape, signed for the other purpose.
    const [, nonce, expires, mac] = enrol.split('.');
    expect((await verifyHomeCookie(SECRET, `v1.${expires}.${mac}`, NOW)).valid).toBe(
      false,
    );
    expect(nonce).toHaveLength(22);
  });
});

describe('helpers', () => {
  it('makes unguessable, well-formed tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, randomToken));
    expect(tokens.size).toBe(100);
    expect([...tokens].every(isToken)).toBe(true);
    expect(isToken('short')).toBe(false);
    expect(isToken(`${randomToken()}x`)).toBe(false);
    expect(isToken(42)).toBe(false);
  });

  it('reads one cookie out of a header', () => {
    expect(readCookie('a=1; __Host-ldn-home=v1.2.x; b=3', '__Host-ldn-home')).toBe(
      'v1.2.x',
    );
    expect(readCookie('x__Host-ldn-home=1', '__Host-ldn-home')).toBeUndefined();
    expect(readCookie(null, '__Host-ldn-home')).toBeUndefined();
  });

  it('only treats this origin as same-origin', () => {
    const request = (headers: Record<string, string>) =>
      new Request('https://ldn.house/api/enrol/start', { method: 'POST', headers });
    expect(isSameOrigin(request({ Origin: 'https://ldn.house' }))).toBe(true);
    expect(
      isSameOrigin(
        request({ Origin: 'https://ldn.house', 'Sec-Fetch-Site': 'same-origin' }),
      ),
    ).toBe(true);
    expect(isSameOrigin(request({}))).toBe(false);
    expect(isSameOrigin(request({ Origin: 'null' }))).toBe(false);
    expect(isSameOrigin(request({ Origin: 'https://attacker.test' }))).toBe(false);
    expect(isSameOrigin(request({ Origin: 'http://ldn.house' }))).toBe(false);
    expect(
      isSameOrigin(
        request({ Origin: 'https://ldn.house', 'Sec-Fetch-Site': 'cross-site' }),
      ),
    ).toBe(false);
  });

  it('only allows the override on local servers and PR previews', () => {
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
