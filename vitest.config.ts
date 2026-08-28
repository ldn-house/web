import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Read at config time so every test worker gets the same parsed migrations.
const migrations = await readD1Migrations('./drizzle');

export default defineConfig({
  plugins: [
    // Bindings are declared here rather than via `wrangler.configPath`: the
    // Worker entry imports `virtual:solid-ssr-handler`, which only exists
    // inside the Solid plugin's build, and tests exercise the libraries
    // directly rather than the entry.
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
  },
});
