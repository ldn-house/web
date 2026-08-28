import { cloudflare } from '@cloudflare/vite-plugin';
import solid from '@solidjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // Start mode owns the entries, the dev SSR middleware and the two builds.
    // The Cloudflare plugin adopts the `ssr` environment (see wrangler.jsonc),
    // so pages render in workerd with bindings in dev as well as production.
    solid({ start: { external: true }, ssr: true }),
    cloudflare(),
    tailwindcss(),
  ],
});
