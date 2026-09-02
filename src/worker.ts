import { handleRequest } from 'virtual:solid-ssr-handler';
import { Hono } from 'hono';
import { BACKFILL_FLOOR, ingest } from './lib/ingest';
import { fetchLiveDemand, type LiveDemand } from './lib/octopus';
import { type OctopusFixture, replayFetcher } from './lib/replay';

const api = new Hono<{ Bindings: Env }>().basePath('/api');

api.get('/health', (c) => c.json({ ok: true }));

api.get('/live-power', async (c) => {
  const cacheKey = new Request(c.req.url, { method: 'GET' });
  const cache = await caches.open('live-power');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let reading: LiveDemand | null;
  try {
    reading = await fetchLiveDemand(c.env.OCTOPUS_API_KEY);
  } catch (error) {
    console.warn('live power unavailable', error);
    return c.json({ error: 'live power unavailable' }, 502);
  }
  if (!reading) return c.json({ error: 'live power unavailable' }, 503);

  const response = c.json(reading);
  response.headers.set('Cache-Control', 'public, max-age=9');
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

/** Absent in production: without SEED_TOKEN the route does not exist. */
api.post('/seed', async (c) => {
  const expected = c.env.SEED_TOKEN;
  if (!expected) return c.notFound();
  if (c.req.header('Authorization') !== `Bearer ${expected}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const fixture = await c.req.json<OctopusFixture>();
  const summary = await ingest(c.env, {
    fetchImpl: replayFetcher(fixture),
    since: BACKFILL_FLOOR,
  });
  return c.json(summary);
});

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }
    return handleRequest(request);
  },

  // The first tick backfills: an empty table has no watermark to resume from.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      ingest(env).then(
        (summary) => console.log('octopus ingest', summary),
        (error) => console.error('octopus ingest failed', error),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
