import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLondonDays, londonMidnight } from './lib/format';
import { signHomeCookie } from './lib/home';
import { consumptionBetween, recentAverageDemand, telemetryBetween } from './lib/queries';
import worker from './worker';

const IP = '198.51.100.7';
const HA_TOKEN = 'synthetic-ha-token';
const WEBHOOK = 'http://192.0.2.20:8123/api/webhook/synthetic-webhook-id';
const COOKIE_SECRET = 'synthetic-cookie-secret';
const HH = 30 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Values that appear nowhere else, so their absence from a response is meaningful.
const TODAY_KWH = 0.271828;
const TODAY_METER_WH = 314.159;
const DEMAND_W = 3141.5;
const LIVE_W = 4242;
const YESTERDAY_KWH = 0.161803;
const TODAY_MARKERS = ['0.2718', '0.3141', '3141', '4242'];

const bindings = {
  ...env,
  HOME_ASSISTANT_TOKEN: HA_TOKEN,
  HOME_ASSISTANT_WEBHOOK_URL: WEBHOOK,
  HOME_COOKIE_SECRET: COOKIE_SECRET,
} as Env;

async function call(
  path: string,
  init: { ip?: string; cookie?: string; host?: string } & RequestInit = {},
  overrides: Partial<Env> = {},
) {
  const { ip = IP, cookie, host = 'https://ldn.house', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (ip) headers.set('CF-Connecting-IP', ip);
  if (cookie) headers.set('Cookie', cookie);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${host}${path}`, { ...rest, headers }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    { ...bindings, ...overrides },
    ctx,
  );
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body };
}

/** A browser-shaped server-function call, with arguments chosen by the caller. */
function callServer(
  fn: unknown,
  args: unknown[],
  init: { ip?: string; cookie?: string } = {},
) {
  return call('/_server', {
    ...init,
    method: 'POST',
    headers: {
      Origin: 'https://ldn.house',
      'Content-Type': 'application/json',
      'X-Server-Function-Id': (fn as { id: string }).id,
      'X-Server-Function-Instance': '1',
      'X-Server-Function-Format': '8',
    },
    body: JSON.stringify(args),
  });
}

const homeCookie = async (secret = COOKIE_SECRET) =>
  `__Host-ldn-home=${await signHomeCookie(secret, Date.now())}`;

/** name=value pairs from every Set-Cookie, as a browser would send them back. */
const cookiesFrom = (response: Response, previous = '') => {
  const jar = new Map(
    previous
      .split('; ')
      .filter(Boolean)
      .map((pair) => pair.split('=') as [string, string]),
  );
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const [name, value] = pair!.split('=') as [string, string];
    if (/Max-Age=0/.test(header)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
};

function expectNoTodayData(body: string) {
  for (const marker of TODAY_MARKERS) expect(body).not.toContain(marker);
  expect(body).not.toContain('spent today');
}

describe('home gate', () => {
  const now = Date.now();
  const today = londonMidnight(new Date(now).toISOString());
  const yesterday = addLondonDays(today, -1);

  beforeEach(async () => {
    const latestPeriod = Math.floor(now / HH) * HH - HH;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM consumption'),
      env.DB.prepare('DELETE FROM telemetry'),
      env.DB.prepare('DELETE FROM live_power_cache'),
      env.DB.prepare('DELETE FROM enrol_codes'),
      env.DB.prepare('DELETE FROM enrol_failures'),
      env.DB.prepare(
        "INSERT INTO consumption VALUES (?, ?, ?, 'SYNTH00000001'), (?, ?, ?, 'SYNTH00000001')",
      ).bind(
        today,
        iso(Date.parse(today) + HH),
        TODAY_KWH,
        iso(Date.parse(yesterday) + 24 * HH),
        iso(Date.parse(yesterday) + 25 * HH),
        YESTERDAY_KWH,
      ),
      // A completed Home Mini period (today unless it is just after midnight)
      // and a recent demand reading for the hourly average.
      env.DB.prepare('INSERT INTO telemetry VALUES (?, ?, 0, ?), (?, ?, 0, NULL)').bind(
        iso(Math.max(latestPeriod, Date.parse(today))),
        DEMAND_W,
        TODAY_METER_WH,
        iso(Math.floor((now - 10 * 60_000) / 60_000) * 60_000),
        DEMAND_W,
      ),
      // Due for a refresh, so any request that reaches it would call Octopus.
      env.DB.prepare(
        'INSERT INTO live_power_cache (id, reading, next_fetch_at) VALUES (1, ?, 0)',
      ).bind(
        JSON.stringify({
          readAt: iso(Math.floor(now / 60_000) * 60_000),
          watts: LIVE_W,
          consumption: [],
        }),
      ),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('outsiders', () => {
    it('get whole days through yesterday and nothing from today', async () => {
      const { response, body } = await call('/');
      expect(response.status).toBe(200);
      expectNoTodayData(body);
      // The hydration payload is in the same document.
      expect(body).toContain('$R');
      expect(body).toContain(String(YESTERDAY_KWH));
      expect(body).toContain('spent yesterday');
      expect(body).toContain('Usage is shown to the end of yesterday.');
      expect(body).toContain('Enrol this device');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('cannot reach live power, and never cause an Octopus request', async () => {
      const upstream = vi.spyOn(globalThis, 'fetch');
      const { response, body } = await call('/api/live-power');
      expect(response.status).toBe(403);
      expect(JSON.parse(body)).toEqual({ error: 'home only' });
      expect(upstream).not.toHaveBeenCalled();
      const cache = await env.DB.prepare(
        'SELECT next_fetch_at, lease_token FROM live_power_cache WHERE id = 1',
      ).first();
      expect(cache).toEqual({ next_fetch_at: 0, lease_token: null });
    });

    it('get nothing from today out of /_server, whatever the arguments', async () => {
      const FAR = Date.parse('2999-01-01T00:00:00Z');
      // Text that sorts after today's timestamps, parseable as a date or not.
      for (const to of ['2999-01-01T00:00:00Z', '9/1/2020', 'not a date', 'z']) {
        for (const [fn, args] of [
          [consumptionBetween, [yesterday, to]],
          [telemetryBetween, [yesterday, to, FAR]],
        ] as const) {
          const { response, body } = await callServer(fn, [...args]);
          expect(response.status).toBe(200);
          expectNoTodayData(body);
        }
      }
      const average = await callServer(recentAverageDemand, [FAR]);
      expect(average.body).toBe('null');
      // The same call from home does return today, so the checks above can fail.
      const home = await callServer(consumptionBetween, [yesterday, 'z'], {
        cookie: await homeCookie(),
      });
      expect(home.body).toContain(String(TODAY_KWH));
    });

    it('cannot use the dev override on a production host', async () => {
      const { response, body } = await call('/?as=home');
      expectNoTodayData(body);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    });

    it('have a forged or revoked cookie cleared', async () => {
      const cookie = await homeCookie();
      const at = cookie.lastIndexOf('.') + 1;
      const forged = `${cookie.slice(0, at)}${cookie[at] === 'A' ? 'B' : 'A'}${cookie.slice(at + 1)}`;
      for (const [value, overrides] of [
        [forged, {}],
        [cookie, { HOME_COOKIE_SECRET: 'rotated-secret' }],
      ] as const) {
        const { response, body } = await call('/', { cookie: value }, overrides);
        expectNoTodayData(body);
        expect(response.headers.get('Set-Cookie')).toMatch(
          /^__Host-ldn-home=; Max-Age=0;/,
        );
      }
    });
  });

  describe('home visitors', () => {
    it('see today with a home cookie, from any address', async () => {
      const cookie = await homeCookie();
      for (const ip of ['198.51.100.7', '2001:db8::1', '203.0.113.200']) {
        const { response, body } = await call('/', { cookie, ip });
        expect(body).toContain('spent today');
        expect(body).toContain(String(TODAY_KWH));
        expect(body).not.toContain('Usage is shown to the end of yesterday.');
        expect(response.headers.get('Set-Cookie')).toBeNull();
      }
    });

    it('can read live power', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { response, body } = await call('/api/live-power', {
        cookie: await homeCookie(),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(body).watts).toBe(LIVE_W);
    });

    it('can be simulated on local servers', async () => {
      const host = 'http://localhost:5173';
      const { response, body } = await call('/?as=home', { host });
      expect(body).toContain('spent today');
      const cookie = cookiesFrom(response);
      expect((await call('/', { host, cookie })).body).toContain('spent today');
      const outsider = await call('/?as=outsider', { host, cookie });
      expectNoTodayData(outsider.body);
      expect(outsider.response.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
    });
  });

  describe('enrolment through the Worker', () => {
    const post = (
      path: string,
      init: { cookie?: string; headers?: HeadersInit; body?: string } = {},
    ) =>
      call(path, {
        method: 'POST',
        cookie: init.cookie,
        body: init.body,
        headers: { Origin: 'https://ldn.house', ...init.headers },
      });
    const confirm = (code: string, check: string, token = HA_TOKEN) =>
      post('/api/home/confirm', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, check }),
      });

    it('turns an outsider into a home visitor once Home Assistant confirms', async () => {
      const started = await post('/api/enrol/start');
      expect(started.response.status).toBe(201);
      let cookie = cookiesFrom(started.response);
      const confirmUrl = new URL(JSON.parse(started.body).confirmUrl);
      const code = confirmUrl.searchParams.get('code')!;
      const check = confirmUrl.searchParams.get('check')!;

      expect(JSON.parse((await post('/api/enrol/status', { cookie })).body)).toEqual({
        state: 'pending',
      });
      expect((await confirm(code, check, 'wrong')).response.status).toBe(401);
      expect((await confirm(code, check)).response.status).toBe(204);

      const claimed = await post('/api/enrol/status', { cookie });
      expect(JSON.parse(claimed.body)).toEqual({ state: 'home' });
      cookie = cookiesFrom(claimed.response, cookie);
      expect(cookie).toMatch(/^__Host-ldn-home=v1\./);
      expect((await call('/', { cookie })).body).toContain('spent today');
      expect((await confirm(code, check)).response.status).toBe(404);
    });

    it('enrols by link without JavaScript', async () => {
      const minted = await post('/api/home/codes', {
        headers: { Authorization: `Bearer ${HA_TOKEN}` },
      });
      const url = new URL(JSON.parse(minted.body).url);
      const opened = await call(`${url.pathname}${url.search}`);
      expect(opened.response.status).toBe(200);
      expect(opened.body).toContain('<form method="post" action="/enrol">');
      const redeemed = await post('/enrol', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: url.searchParams.get('code')! }).toString(),
      });
      expect(redeemed.response.status).toBe(303);
      const cookie = cookiesFrom(redeemed.response);
      expect((await call('/', { cookie })).body).toContain('spent today');
    });
  });
});
