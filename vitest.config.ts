import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import solid from '@solidjs/vite-plugin';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('./drizzle');

export default defineConfig({
  plugins: [
    // Bindings declared here rather than via `wrangler.configPath`: the Worker
    // entry imports `virtual:solid-ssr-handler`, which only exists inside the
    // Solid plugin's build.
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-28',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        bindings: {
          TEST_MIGRATIONS: migrations,
          OCTOPUS_API_KEY: 'synthetic-key-not-a-real-credential',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./src/test/apply-migrations.ts'],
    projects: [
      {
        extends: true,
        test: { name: 'unit', exclude: ['**/node_modules/**', 'src/**/*.ssr.test.ts'] },
      },
      {
        // Renders the real Worker entry, so tests can assert on the HTML it
        // serves. Server functions here only run inside a request.
        extends: true,
        plugins: [
          solid({
            start: { external: true },
            ssr: true,
            serverFunctions: { devMiddleware: false },
          }),
        ],
        // `node` selects Solid's server build; the Workers pool supplies the runtime.
        test: { name: 'ssr', include: ['src/**/*.ssr.test.ts'], environment: 'node' },
      },
    ],
  },
});
