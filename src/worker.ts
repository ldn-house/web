import { handleRequest } from 'virtual:solid-ssr-handler';
import { Hono } from 'hono';
import {
  browserEnrolmentStatus,
  confirmBrowserEnrolment,
  enrolmentLinkPage,
  mintEnrolmentLink,
  resolveVisitor,
  startBrowserEnrolment,
} from './lib/home-gate';
import { BACKFILL_FLOOR, ingest } from './lib/ingest';
import { livePowerResponse } from './lib/live-power';
import { type OctopusFixture, replayFetcher } from './lib/replay';
import { isHome, withVisitor } from './lib/visitor';

const api = new Hono<{ Bindings: Env }>().basePath('/api');

api.get('/health', (c) => c.json({ ok: true }));

// Checked before D1 is touched, so only home visitors can cause an Octopus request.
api.get('/live-power', async (c) =>
  isHome()
    ? livePowerResponse(c.env.DB, c.env.OCTOPUS_API_KEY)
    : c.json({ error: 'home only' }, 403, { 'Cache-Control': 'no-store' }),
);

api.post('/enrol/start', (c) => startBrowserEnrolment(c.req.raw, c.env));
api.post('/enrol/status', (c) => browserEnrolmentStatus(c.req.raw, c.env));
api.post('/home/confirm', (c) => confirmBrowserEnrolment(c.req.raw, c.env));
api.post('/home/codes', (c) => mintEnrolmentLink(c.req.raw, c.env));

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

/** Routes that never read the visitor; enrolment sets its own cookies. */
const UNGATED = new Set([
  '/api/health',
  '/api/seed',
  '/api/enrol/start',
  '/api/enrol/status',
  '/api/home/confirm',
  '/api/home/codes',
]);

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (UNGATED.has(pathname)) return api.fetch(request, env, ctx);
    if (pathname === '/enrol') return enrolmentLinkPage(request, env);

    const visitor = await resolveVisitor(request, env);
    const upstream = await withVisitor({ home: visitor.home }, () =>
      isApi ? api.fetch(request, env, ctx) : handleRequest(request),
    );
    // Pages, server functions and the live API all differ between home and away.
    const response = new Response(upstream.body, upstream);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.append('Vary', 'Cookie');
    for (const cookie of visitor.cookies) response.headers.append('Set-Cookie', cookie);
    return response;
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
