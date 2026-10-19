import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLondonDays, londonMidnight } from './lib/format';
import { HOME_ADDRESS_TTL_MS } from './lib/home';
import { consumptionBetween, recentAverageDemand, telemetryBetween } from './lib/queries';
import worker from './worker';

const HOME_IP = '192.0.2.10';
const AWAY_IP = '198.51.100.7';
const REPORT_TOKEN = 'synthetic-report-token';
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
  HOME_REPORT_TOKEN: REPORT_TOKEN,
  HOME_COOKIE_SECRET: COOKIE_SECRET,
} as Env;

async function call(
  path: string,
  init: { ip?: string; cookie?: string; host?: string } & RequestInit = {},
  overrides: Partial<Env> = {},
) {
  const { ip, cookie, host = 'https://ldn.house', ...rest } = init;
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

async function reportHome(reportedAt: number, ipv6Prefix: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO home_address (id, ipv4, ipv6_prefix, reported_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ipv4 = excluded.ipv4, ipv6_prefix = excluded.ipv6_prefix,
      reported_at = excluded.reported_at`,
  )
    .bind(HOME_IP, ipv6Prefix, reportedAt)
    .run();
}

const cookieFrom = (response: Response) =>
  response.headers.get('Set-Cookie')?.split(';')[0] ?? undefined;

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
      env.DB.prepare('DELETE FROM home_address'),
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
      await reportHome(now - 60_000);
      const { response, body } = await call('/', { ip: AWAY_IP });
      expect(response.status).toBe(200);
      expectNoTodayData(body);
      // The hydration payload is in the same document.
      expect(body).toContain('$R');
      expect(body).toContain(String(YESTERDAY_KWH));
      expect(body).toContain('spent yesterday');
      expect(body).toContain('Usage is shown to the end of yesterday.');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('cannot reach live power, and never cause an Octopus request', async () => {
      const upstream = vi.spyOn(globalThis, 'fetch');
      const { response, body } = await call('/api/live-power', { ip: AWAY_IP });
      expect(response.status).toBe(403);
      expect(JSON.parse(body)).toEqual({ error: 'home only' });
      expect(upstream).not.toHaveBeenCalled();
      const cache = await env.DB.prepare(
        'SELECT next_fetch_at, lease_token FROM live_power_cache WHERE id = 1',
      ).first();
      expect(cache).toEqual({ next_fetch_at: 0, lease_token: null });
    });

    it('get nothing from today out of /_server, whatever the arguments', async () => {
      await reportHome(now - 60_000);
      const FAR = Date.parse('2999-01-01T00:00:00Z');
      // Text that sorts after today's timestamps, parseable as a date or not.
      for (const to of ['2999-01-01T00:00:00Z', '9/1/2020', 'not a date', 'z']) {
        for (const [fn, args] of [
          [consumptionBetween, [yesterday, to]],
          [telemetryBetween, [yesterday, to, FAR]],
        ] as const) {
          const { response, body } = await callServer(fn, [...args], { ip: AWAY_IP });
          expect(response.status).toBe(200);
          expectNoTodayData(body);
        }
      }
      const average = await callServer(recentAverageDemand, [FAR], { ip: AWAY_IP });
      expect(average.body).toBe('null');
      // The same call from home does return today, so the checks above can fail.
      const home = await callServer(consumptionBetween, [yesterday, 'z'], {
        ip: HOME_IP,
      });
      expect(home.body).toContain(String(TODAY_KWH));
    });

    it('stop matching once the address goes stale', async () => {
      await reportHome(now - HOME_ADDRESS_TTL_MS - 5_000);
      const { response, body } = await call('/', { ip: HOME_IP });
      expectNoTodayData(body);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    });

    it('cannot use the dev override on a production host', async () => {
      const { response, body } = await call('/?as=home', { ip: AWAY_IP });
      expectNoTodayData(body);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    });

    it('have a forged or revoked cookie cleared', async () => {
      await reportHome(now - 60_000);
      const { response: issued } = await call('/', { ip: HOME_IP });
      const cookie = cookieFrom(issued)!;
      // Change a character that carries signature bits; the last one partly
      // encodes base64 padding, which decodes identically.
      const at = cookie.length - 10;
      const forged = `${cookie.slice(0, at)}${cookie[at] === 'A' ? 'B' : 'A'}${cookie.slice(at + 1)}`;
      for (const [value, overrides] of [
        [forged, {}],
        [cookie, { HOME_COOKIE_SECRET: 'rotated-secret' }],
      ] as const) {
        const { response, body } = await call(
          '/',
          { ip: AWAY_IP, cookie: value },
          overrides,
        );
        expectNoTodayData(body);
        expect(response.headers.get('Set-Cookie')).toMatch(
          /^__Host-ldn-home=; Max-Age=0;/,
        );
      }
    });
  });

  describe('home visitors', () => {
    it('see today and get a cookie when the address matches', async () => {
      await reportHome(now - 60_000);
      const { response, body } = await call('/', { ip: HOME_IP });
      expect(body).toContain('spent today');
      expect(body).toContain(String(TODAY_KWH));
      expect(body).not.toContain('Usage is shown to the end of yesterday.');
      expect(response.headers.get('Set-Cookie')).toMatch(
        /^__Host-ldn-home=v1\.\d+\.[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
      );
    });

    it('match inside the reported IPv6 prefix', async () => {
      await reportHome(now - 60_000, '2001:db8:1200::/56');
      const inside = await call('/', { ip: '2001:db8:1200:ff::1' });
      expect(inside.body).toContain('spent today');
      const outside = await call('/', { ip: '2001:db8:1201::1' });
      expectNoTodayData(outside.body);
    });

    it('keep access with the cookie after the address stops matching', async () => {
      await reportHome(now - 60_000);
      const { response: issued } = await call('/', { ip: HOME_IP });
      await env.DB.prepare('DELETE FROM home_address').run();
      const { response, body } = await call('/', {
        ip: AWAY_IP,
        cookie: cookieFrom(issued),
      });
      expect(body).toContain('spent today');
      // Away from home the cookie is honoured but not extended.
      expect(response.headers.get('Set-Cookie')).toBeNull();
    });

    it('can read live power', async () => {
      await reportHome(now - 60_000);
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { response, body } = await call('/api/live-power', { ip: HOME_IP });
      expect(response.status).toBe(200);
      expect(JSON.parse(body).watts).toBe(LIVE_W);
    });

    it('can be simulated on local servers', async () => {
      const host = 'http://localhost:5173';
      const { response, body } = await call('/?as=home', { host, ip: AWAY_IP });
      expect(body).toContain('spent today');
      const cookie = cookieFrom(response);
      const away = await call('/?as=away', { host, cookie });
      expect(away.body).toContain('spent today');
      const outsider = await call('/?as=outsider', { host, cookie });
      expectNoTodayData(outsider.body);
      expect(outsider.response.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
    });
  });

  describe('POST /api/home/address', () => {
    const report = (body: unknown, token: string | null = REPORT_TOKEN) =>
      call('/api/home/address', {
        method: 'POST',
        ip: HOME_IP,
        headers: {
          'Content-Type': 'application/json',
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    const stored = () => env.DB.prepare('SELECT * FROM home_address').all();

    it('does not exist without a configured token', async () => {
      const { response } = await call(
        '/api/home/address',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' },
          body: JSON.stringify({ ipv4: HOME_IP }),
        },
        { HOME_REPORT_TOKEN: undefined },
      );
      expect(response.status).toBe(404);
      expect((await stored()).results).toEqual([]);
    });

    it('rejects missing and wrong tokens', async () => {
      for (const token of [
        null,
        '',
        'wrong',
        `${REPORT_TOKEN}x`,
        REPORT_TOKEN.slice(1),
      ]) {
        const { response } = await report({ ipv4: HOME_IP }, token);
        expect(response.status).toBe(401);
      }
      expect((await stored()).results).toEqual([]);
    });

    it('rejects addresses it cannot match on', async () => {
      for (const body of [
        {},
        { ipv4: 'unavailable' },
        { ipv4: '192.0.2.300' },
        { ipv4: HOME_IP, ipv6_prefix: '2001:db8::/32' },
        { ipv4: HOME_IP, ipv6_prefix: 'unknown' },
      ]) {
        expect((await report(body)).response.status).toBe(400);
      }
      expect((await stored()).results).toEqual([]);
    });

    it('stores the address, which then admits the house', async () => {
      const { response } = await report({
        ipv4: HOME_IP,
        ipv6_prefix: '2001:db8:1200::/56',
      });
      expect(response.status).toBe(204);
      const [row] = (await stored()).results as { reported_at: number }[];
      expect(row).toMatchObject({ ipv4: HOME_IP, ipv6_prefix: '2001:db8:1200::/56' });
      expect(Math.abs(row!.reported_at - Date.now())).toBeLessThan(5_000);
      expect((await call('/', { ip: HOME_IP })).body).toContain('spent today');

      // A heartbeat without a prefix clears it.
      expect((await report({ ipv4: HOME_IP })).response.status).toBe(204);
      expect((await stored()).results).toMatchObject([{ ipv6_prefix: null }]);
    });
  });
});
