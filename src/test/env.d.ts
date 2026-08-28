import type { D1Migration } from 'cloudflare:test';

/** Test-only bindings from `vitest.config.ts`. v1 types `env` as `Cloudflare.Env`. */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
