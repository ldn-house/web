import { cloudflare } from '@cloudflare/vite-plugin';
import solid from '@solidjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // `external` hands the server environment to the Cloudflare plugin, which
    // builds its own rather than adopting Solid's `ssr` one.
    solid({ start: { external: true }, ssr: true }),
    cloudflare(),
    tailwindcss(),
  ],
});
