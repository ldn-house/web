import { handleRequest } from 'virtual:solid-ssr-handler';
import { Hono } from 'hono';
import { ingest } from './lib/ingest';

const api = new Hono<{ Bindings: Env }>().basePath('/api');

api.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Hono owns the JSON API and webhook endpoints; Solid renders everything else.
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }
    return handleRequest(request);
  },

  // The first tick backfills, because an empty table has no watermark to
  // resume from; every tick after that pulls only what is new.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      ingest(env).then(
        (summary) => console.log('octopus ingest', summary),
        (error) => console.error('octopus ingest failed', error),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
