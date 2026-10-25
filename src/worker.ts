import { handleRequest } from 'virtual:solid-ssr-handler';
import { Hono } from 'hono';
import { simulatedNow } from './lib/home';
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
import { treeIndex } from './lib/tree-export';
import { isHome, withVisitor } from './lib/visitor';

const api = new Hono<{ Bindings: Env }>().basePath('/api');

api.get('/health', (c) => c.json({ ok: true, treeExport: treeIndex?.archive ?? null }));

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
    const url = new URL(request.url);
    // Exact host only; redirect before enrolment so its form uses the apex origin.
    if (url.hostname === 'www.ldn.house') {
      url.protocol = 'https:';
      url.host = 'ldn.house';
      url.port = '';
      return Response.redirect(url.href, 301);
    }

    const { pathname } = url;
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    let response: Response;
    if (pathname === '/robots.txt') {
      response = new Response(
        url.hostname === 'ldn.house'
          ? 'User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /_server\nDisallow: /enrol\n'
          : 'User-agent: *\nDisallow: /\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    } else if (UNGATED.has(pathname)) {
      // Enrolment endpoints manage their own cookies and authentication.
      response = await api.fetch(request, env, ctx);
    } else if (pathname === '/enrol') {
      response = await enrolmentLinkPage(request, env);
    } else if (isApi || pathname === '/_server' || pathname === '/') {
      if (pathname === '/' && request.method !== 'GET' && request.method !== 'HEAD') {
        response = new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      } else {
        // Keep the visitor context around both streamed SSR and server functions.
        const visitor = await resolveVisitor(request, env);
        const now = simulatedNow(url);
        const upstream = await withVisitor({ home: visitor.home, now }, () =>
          isApi ? api.fetch(request, env, ctx) : handleRequest(request),
        );
        response = new Response(upstream.body, upstream);
        response.headers.set('Cache-Control', 'private, no-store');
        response.headers.append('Vary', 'Cookie');
        for (const cookie of visitor.cookies)
          response.headers.append('Set-Cookie', cookie);
      }
    } else {
      response = await env.ASSETS.fetch(request);
      if (response.status === 404 || pathname === '/404.html') {
        const notFound = await env.ASSETS.fetch(new URL('/404.html', url));
        response = new Response(notFound.body, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    const headers = new Headers(response.headers);
    if (url.hostname !== 'ldn.house' || response.status === 404) {
      headers.set('X-Robots-Tag', 'noindex');
    }
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
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
