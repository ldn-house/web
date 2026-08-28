import { cloudflare } from '@cloudflare/vite-plugin';
import solid from '@solidjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // `external` hands the server environment to the Cloudflare plugin, which
    // builds its own rather than adopting Solid's `ssr` one.
    solid({
      start: { external: true },
      ssr: true,
      // devMiddleware: false lets the Cloudflare plugin dispatch the endpoint,
      // so server functions run in workerd with bindings rather than in Node.
      serverFunctions: { devMiddleware: false },
    }),
    // CI points this at a generated per-PR config; defaults to wrangler.jsonc.
    cloudflare({ configPath: process.env.WRANGLER_CONFIG }),
    tailwindcss(),
  ],
});
