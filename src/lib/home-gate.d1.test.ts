import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ENROL_TTL_S, readCookie, signHomeCookie } from './home';
import {
  browserEnrolmentStatus,
  confirmBrowserEnrolment,
  enrolmentLinkPage,
  mintEnrolmentLink,
  resolveVisitor,
  startBrowserEnrolment,
} from './home-gate';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const ORIGIN = 'https://ldn.house';
const TOKEN = 'synthetic-ha-token';
const SECRET = 'synthetic-cookie-secret';
const WEBHOOK = 'http://192.0.2.20:8123/api/webhook/synthetic-webhook-id';
const homeEnv = {
  DB: env.DB,
  HOME_ASSISTANT_TOKEN: TOKEN,
  HOME_COOKIE_SECRET: SECRET,
  HOME_ASSISTANT_WEBHOOK_URL: WEBHOOK,
};

/** Each browser keeps its own cookies, as a real one would. */
function browser(ip = '198.51.100.7') {
  const jar = new Map<string, string>();
  const keep = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];
      if (attributes.some((a) => a.trim() === 'Max-Age=0')) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  const request = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
    const { origin = ORIGIN, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (origin) headers.set('Origin', origin);
    headers.set('CF-Connecting-IP', ip);
    if (jar.size) {
      headers.set(
        'Cookie',
        [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    return new Request(`${ORIGIN}${path}`, { method: 'POST', ...rest, headers });
  };
  return {
    jar,
    async start(now = NOW, init = {}) {
      return keep(
        await startBrowserEnrolment(request('/api/enrol/start', init), homeEnv, now),
      );
    },
    async status(now = NOW, init = {}) {
      return keep(
        await browserEnrolmentStatus(request('/api/enrol/status', init), homeEnv, now),
      );
    },
    async page(method: string, code: string, now = NOW, init = {}) {
      const body = method === 'POST' ? new URLSearchParams({ code }) : undefined;
      const path = method === 'GET' ? `/enrol?code=${code}` : '/enrol';
      return keep(
        await enrolmentLinkPage(request(path, { method, body, ...init }), homeEnv, now),
      );
    },
    async isHome(now = NOW) {
      const page = request('/', { method: 'GET', origin: null });
      return (await resolveVisitor(page, homeEnv, now)).home;
    },
  };
}

const codeFrom = async (response: Response) => {
  const { confirmUrl } = (await response.json()) as { confirmUrl: string };
  return new URL(confirmUrl).searchParams.get('code')!;
};

function homeAssistant(path: string, body?: unknown, token: string | null = TOKEN) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const confirm = (code: string, now = NOW, token: string | null = TOKEN) =>
  confirmBrowserEnrolment(
    homeAssistant('/api/home/confirm', { code }, token),
    homeEnv,
    now,
  );

const stateOf = async (response: Response) =>
  ((await response.json()) as { state: string }).state;

describe('enrolment from home', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM enrol_codes'),
      env.DB.prepare('DELETE FROM enrol_failures'),
    ]);
  });

  it('enrols the browser that asked, once Home Assistant confirms its code', async () => {
    const phone = browser();
    const started = await phone.start();
    expect(started.status).toBe(201);
    const confirmUrl = new URL(
      ((await started.clone().json()) as { confirmUrl: string }).confirmUrl,
    );
    expect(`${confirmUrl.origin}${confirmUrl.pathname}`).toBe(WEBHOOK);
    expect(started.headers.get('Set-Cookie')).toMatch(
      /^__Host-ldn-enrol=v1\.[\w-]{22}\.\d+\.[\w-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    const code = await codeFrom(started);

    expect(await stateOf(await phone.status())).toBe('pending');
    expect(await phone.isHome()).toBe(false);
    expect((await confirm(code)).status).toBe(204);

    const claimed = await phone.status(NOW + 5_000);
    expect(await stateOf(claimed)).toBe('home');
    expect(claimed.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__Host-ldn-enrol=; Max-Age=0;/),
      expect.stringMatching(/^__Host-ldn-home=v1\.\d+\.[\w-]{43}; Max-Age=2592000;/),
    ]);
    expect(await phone.isHome(NOW + 5_000)).toBe(true);
  });

  it('completes on the next page load, if the polling page was reloaded or discarded', async () => {
    const phone = browser();
    const code = await codeFrom(await phone.start());
    // Before confirmation the pending cookie is kept and nothing changes.
    const page = () =>
      new Request(`${ORIGIN}/`, {
        headers: { Cookie: `__Host-ldn-enrol=${phone.jar.get('__Host-ldn-enrol')}` },
      });
    expect(await resolveVisitor(page(), homeEnv, NOW)).toEqual({
      home: false,
      cookies: [],
    });
    expect((await confirm(code)).status).toBe(204);
    const visitor = await resolveVisitor(page(), homeEnv, NOW + 5_000);
    expect(visitor).toEqual({
      home: true,
      cookies: [
        expect.stringMatching(/^__Host-ldn-enrol=; Max-Age=0/),
        expect.stringMatching(/^__Host-ldn-home=v1\./),
      ],
    });
    // If that response is lost, the same browser can claim again for a minute.
    expect((await resolveVisitor(page(), homeEnv, NOW + 60_000)).home).toBe(true);
    expect(await resolveVisitor(page(), homeEnv, NOW + 65_001)).toEqual({
      home: false,
      cookies: [expect.stringMatching(/^__Host-ldn-enrol=; Max-Age=0/)],
    });
  });

  it('never stores the code or nonce itself', async () => {
    const phone = browser();
    const code = await codeFrom(await phone.start());
    const stored = JSON.stringify(
      (await env.DB.prepare('SELECT * FROM enrol_codes').all()).results,
    );
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(phone.jar.get('__Host-ldn-enrol')!.split('.')[1]);
  });

  it('enrols no other browser with a confirmed code', async () => {
    const phone = browser();
    const code = await codeFrom(await phone.start());
    const intruder = browser('203.0.113.9');
    await intruder.start();
    expect((await confirm(code)).status).toBe(204);

    // The intruder's own pending code is unconfirmed; one with no cookie has nothing.
    expect(await stateOf(await intruder.status())).toBe('pending');
    expect(await intruder.isHome()).toBe(false);
    const stranger = browser('203.0.113.10');
    expect(await stateOf(await stranger.status())).toBe('expired');
    // A pending cookie carrying the phone's nonce, without a valid signature, is refused.
    const pending = phone.jar.get('__Host-ldn-enrol')!;
    const at = pending.lastIndexOf('.') + 1;
    const forged = `${pending.slice(0, at)}${pending[at] === 'A' ? 'B' : 'A'}${pending.slice(at + 1)}`;
    stranger.jar.set('__Host-ldn-enrol', forged);
    expect(await stateOf(await stranger.status())).toBe('expired');

    expect(await stateOf(await phone.status())).toBe('home');
  });

  it('spends a code once', async () => {
    const phone = browser();
    const code = await codeFrom(await phone.start());
    expect((await confirm(code)).status).toBe(204);
    expect((await confirm(code)).status).toBe(404);
    const pending = phone.jar.get('__Host-ldn-enrol')!;
    expect(await stateOf(await phone.status())).toBe('home');
    expect(phone.jar.has('__Host-ldn-enrol')).toBe(false);
    // The pending cookie stands for that browser for a minute after the claim,
    // so a lost response can be retried; after that a replay claims nothing.
    const replay = browser('203.0.113.9');
    replay.jar.set('__Host-ldn-enrol', pending);
    expect(await stateOf(await replay.status(NOW + 59_999))).toBe('home');
    const late = browser('203.0.113.10');
    late.jar.set('__Host-ldn-enrol', pending);
    expect(await stateOf(await late.status(NOW + 60_000))).toBe('expired');
    expect(await late.isHome(NOW + 60_000)).toBe(false);
  });

  it('refuses a code confirmed, or claimed, after it expires', async () => {
    const late = browser();
    const code = await codeFrom(await late.start());
    expect((await confirm(code, NOW + ENROL_TTL_S * 1000)).status).toBe(404);
    expect(await stateOf(await late.status(NOW + ENROL_TTL_S * 1000))).toBe('expired');

    const slow = browser();
    const slowCode = await codeFrom(await slow.start());
    expect((await confirm(slowCode, NOW + 60_000)).status).toBe(204);
    expect(await stateOf(await slow.status(NOW + ENROL_TTL_S * 1000 + 1))).toBe(
      'expired',
    );
    expect(await slow.isHome(NOW + ENROL_TTL_S * 1000 + 1)).toBe(false);
  });

  it('refuses cross-site and origin-less requests', async () => {
    const phone = browser();
    for (const init of [
      { origin: 'https://attacker.test' },
      { origin: null },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    ]) {
      expect((await phone.start(NOW, init)).status).toBe(403);
      expect((await phone.status(NOW, init)).status).toBe(403);
    }
    expect(phone.jar.size).toBe(0);
  });

  it('requires Home Assistant’s token to confirm', async () => {
    const code = await codeFrom(await browser().start());
    for (const token of [null, '', 'wrong', `${TOKEN}x`, TOKEN.slice(1)]) {
      expect((await confirm(code, NOW, token)).status).toBe(401);
    }
    const unconfigured = await confirmBrowserEnrolment(
      homeAssistant('/api/home/confirm', { code }),
      { ...homeEnv, HOME_ASSISTANT_TOKEN: undefined },
      NOW,
    );
    expect(unconfigured.status).toBe(404);
    // None of those spent it.
    expect((await confirm(code)).status).toBe(204);
  });

  it('rejects malformed codes without throwing', async () => {
    for (const code of [undefined, '', 'short', 42, { $ne: null }, 'x'.repeat(22)]) {
      expect((await confirm(code as string)).status).toBe(404);
    }
  });

  it('is unavailable until the webhook and secret are configured', async () => {
    const request = () =>
      new Request(`${ORIGIN}/api/enrol/start`, {
        method: 'POST',
        headers: { Origin: ORIGIN },
      });
    for (const missing of [
      { HOME_ASSISTANT_WEBHOOK_URL: undefined },
      { HOME_ASSISTANT_WEBHOOK_URL: 'javascript:alert(1)' },
      { HOME_COOKIE_SECRET: undefined },
    ]) {
      const response = await startBrowserEnrolment(
        request(),
        { ...homeEnv, ...missing },
        NOW,
      );
      expect(response.status).toBe(503);
    }
  });

  it('rate-limits code requests per client and failed confirmations overall', async () => {
    const phone = browser();
    for (let i = 0; i < 5; i += 1) expect((await phone.start()).status).toBe(201);
    const limited = await phone.start();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('600');
    expect((await browser('203.0.113.9').start()).status).toBe(201);
    expect((await phone.start(NOW + 10 * 60_000 + 1)).status).toBe(201);

    const code = await codeFrom(await browser('203.0.113.11').start());
    for (let i = 0; i < 20; i += 1) await confirm('A'.repeat(22));
    expect((await confirm(code)).status).toBe(429);
    expect((await confirm(code, NOW + 10 * 60_000 + 1)).status).toBe(404);
  });
});

describe('enrolment by link', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM enrol_codes'),
      env.DB.prepare('DELETE FROM enrol_failures'),
    ]);
  });

  const mint = async (now = NOW, token: string | null = TOKEN) =>
    mintEnrolmentLink(homeAssistant('/api/home/codes', undefined, token), homeEnv, now);
  const linkCode = async (response: Response) =>
    new URL(((await response.json()) as { url: string }).url).searchParams.get('code')!;

  it('mints a link only for Home Assistant', async () => {
    for (const token of [null, 'wrong'])
      expect((await mint(NOW, token)).status).toBe(401);
    const minted = await mint();
    expect(minted.status).toBe(201);
    const body = (await minted.json()) as { url: string; expiresAt: string };
    expect(body.url).toMatch(/^https:\/\/ldn\.house\/enrol\?code=[\w-]{22}$/);
    expect(body.expiresAt).toBe(new Date(NOW + ENROL_TTL_S * 1000).toISOString());
  });

  it('only spends the code on a same-origin POST, once', async () => {
    const code = await linkCode(await mint());
    const phone = browser();

    // Opening the link, as a preview might, spends nothing.
    const opened = await phone.page('GET', code);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('Enrol this device');
    expect(await phone.isHome()).toBe(false);

    expect(
      (await phone.page('POST', code, NOW, { origin: 'https://attacker.test' })).status,
    ).toBe(403);
    expect((await phone.page('POST', code, NOW, { origin: null })).status).toBe(403);

    const redeemed = await phone.page('POST', code);
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get('Location')).toBe('/');
    expect(await phone.isHome()).toBe(true);

    const again = browser('203.0.113.9');
    expect((await again.page('POST', code)).status).toBe(410);
    expect(await again.isHome()).toBe(false);
  });

  it('expires after ten minutes', async () => {
    const code = await linkCode(await mint());
    const phone = browser();
    expect((await phone.page('POST', code, NOW + ENROL_TTL_S * 1000)).status).toBe(410);
    expect(readCookie(null, '__Host-ldn-home')).toBeUndefined();
    expect(await phone.isHome()).toBe(false);
  });

  it('cannot redeem a browser code as a link, or confirm a link code', async () => {
    const phone = browser();
    const browserCode = await codeFrom(await phone.start());
    expect((await phone.page('POST', browserCode)).status).toBe(410);
    const code = await linkCode(await mint());
    expect((await confirm(code)).status).toBe(404);
  });

  it('escapes whatever arrives in the link', async () => {
    const page = await browser().page('GET', '"><script>alert(1)</script>');
    const html = await page.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('rate-limits failed redemptions per client', async () => {
    const guesser = browser('203.0.113.12');
    for (let i = 0; i < 10; i += 1) {
      expect((await guesser.page('POST', 'A'.repeat(22))).status).toBe(410);
    }
    const code = await linkCode(await mint());
    expect((await guesser.page('POST', code)).status).toBe(429);
    // Someone else is unaffected.
    expect((await browser('203.0.113.13').page('POST', code)).status).toBe(303);
  });

  it('caps how many links Home Assistant can mint', async () => {
    for (let i = 0; i < 10; i += 1) expect((await mint()).status).toBe(201);
    expect((await mint()).status).toBe(429);
  });
});

describe('home cookie', () => {
  it('is re-signed on use once a day old, and cleared if invalid', async () => {
    const page = (cookie: string) =>
      new Request(`${ORIGIN}/`, { headers: { Cookie: `__Host-ldn-home=${cookie}` } });
    const fresh = await signHomeCookie(SECRET, NOW);
    expect(await resolveVisitor(page(fresh), homeEnv, NOW + 60_000)).toEqual({
      home: true,
      cookies: [],
    });
    const day = await resolveVisitor(page(fresh), homeEnv, NOW + 86_400_000);
    expect(day).toEqual({
      home: true,
      cookies: [expect.stringMatching(/^__Host-ldn-home=v1\./)],
    });
    const rotated = await resolveVisitor(
      page(fresh),
      { ...homeEnv, HOME_COOKIE_SECRET: 'rotated' },
      NOW,
    );
    expect(rotated).toEqual({
      home: false,
      cookies: [expect.stringMatching(/^__Host-ldn-home=; Max-Age=0/)],
    });
  });

  it('cannot be simulated on a production host', async () => {
    const visitor = await resolveVisitor(new Request(`${ORIGIN}/?as=home`), homeEnv, NOW);
    expect(visitor).toEqual({ home: false, cookies: [] });
  });
});
