import type { D1Migration } from 'cloudflare:test';

/**
 * Test-only bindings supplied by `vitest.config.ts`. In v1 of the plugin
 * `cloudflare:test`'s `env` is typed as `Cloudflare.Env`, so the augmentation
 * goes there rather than on the old `ProvidedEnv`.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
