import { cloudflare } from '@cloudflare/vite-plugin';
import solid from '@solidjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // `external` hands the server environment to the Cloudflare plugin, which
    // builds its own rather than adopting Solid's `ssr` one.
    solid({ start: { external: true }, ssr: true }),
    // CI points this at a generated per-PR config; defaults to wrangler.jsonc.
    cloudflare({ configPath: process.env.WRANGLER_CONFIG }),
    tailwindcss(),
  ],
});
