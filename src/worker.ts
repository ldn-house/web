import { handleRequest } from 'virtual:solid-ssr-handler';
import { Hono } from 'hono';

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
} satisfies ExportedHandler<Env>;
