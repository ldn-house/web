import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signHomeCookie } from './lib/home';
import { treeIndex } from './lib/tree-export';
import worker from './worker';

const COOKIE_SECRET = 'synthetic-cookie-secret';
const bindings = { ...env, HOME_COOKIE_SECRET: COOKIE_SECRET } as Env;

const OCTOBER = Date.parse('2026-10-20T12:00:00Z');
const DECEMBER = Date.parse('2026-12-15T12:00:00Z');

async function page(path: string, init: { host?: string; cookie?: string } = {}) {
  const { host = 'https://ldn.house', cookie } = init;
  const headers = new Headers({ 'CF-Connecting-IP': '198.51.100.7' });
  if (cookie) headers.set('Cookie', cookie);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${host}${path}`, { headers }) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    bindings,
    ctx,
  );
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return body;
}

/** Anything the panel puts in the page, including what would load its code or data. */
function expectNoTree(body: string) {
  expect(body).not.toContain('Christmas tree');
  expect(body).not.toContain('<circle');
  expect(body).not.toMatch(/TreePanel|tree-player|\.frames|coords/);
}

// Without the build-time export the panel renders nothing anywhere, so the
// cases that expect it only run where src/tree-export/ has been fetched.
const withExport = it.skipIf(!treeIndex);

describe('tree panel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absent for outsiders out of season', async () => {
    vi.useFakeTimers({ now: OCTOBER, toFake: ['Date'] });
    expectNoTree(await page('/'));
  });

  it.each(['https://ldn.house', 'https://preview.ldn.house'])(
    'ignores simulated visitor and date overrides on %s',
    async (host) => {
      vi.useFakeTimers({ now: OCTOBER, toFake: ['Date'] });
      expectNoTree(await page('/?as=home&at=2026-12-15', { host }));
      expectNoTree(await page('/?as=outsider&at=2026-12-15', { host }));
    },
  );

  it('preserves simulation queries in the www redirect but ignores them on the apex', async () => {
    vi.useFakeTimers({ now: OCTOBER, toFake: ['Date'] });
    const path = '/?as=home&at=2026-12-15';
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://www.ldn.house${path}`) as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(`https://ldn.house${path}`);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expectNoTree(await page(path));
  });

  it.skipIf(!treeIndex).each(['https://ldn.house', 'https://preview.ldn.house'])(
    'does not hide the seasonal tree through date simulation on %s',
    async (host) => {
      vi.useFakeTimers({ now: DECEMBER, toFake: ['Date'] });
      expect(await page('/?as=outsider&at=2026-10-20', { host })).toContain(
        'Christmas tree',
      );
    },
  );

  withExport('shows outsiders the tree in season', async () => {
    vi.useFakeTimers({ now: DECEMBER, toFake: ['Date'] });
    expect(await page('/')).toContain('Christmas tree');
  });

  withExport('shows the household the tree all year', async () => {
    vi.useFakeTimers({ now: OCTOBER, toFake: ['Date'] });
    const cookie = `__Host-ldn-home=${await signHomeCookie(COOKIE_SECRET, Date.now())}`;
    expect(await page('/', { cookie })).toContain('Christmas tree');
  });

  withExport('lets local servers simulate the date', async () => {
    vi.useFakeTimers({ now: OCTOBER, toFake: ['Date'] });
    const host = 'http://localhost:5173';
    expectNoTree(await page('/?as=outsider', { host }));
    expect(await page('/?as=outsider&at=2026-12-15', { host })).toContain(
      'Christmas tree',
    );
    expectNoTree(await page('/?as=outsider&at=2027-01-07T00:00:00Z', { host }));
  });

  it('reports the export it was built from at /api/health', async () => {
    expect(JSON.parse(await page('/api/health'))).toEqual({
      ok: true,
      treeExport: treeIndex?.archive ?? null,
    });
  });

  it.skipIf(!treeIndex?.archive)('records the archive digest with the export', () => {
    expect(treeIndex?.archive).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
