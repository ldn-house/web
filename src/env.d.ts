/** Secrets set with `wrangler secret put`, absent from wrangler.jsonc. */
declare global {
  interface Env {
    OCTOPUS_API_KEY: string;
    /** Set only on preview deployments; absent in production, where seeding 404s. */
    SEED_TOKEN?: string;
    /** Home Assistant's bearer token for `POST /api/home/address`; the route 404s without it. */
    HOME_REPORT_TOKEN?: string;
    /** Signs home cookies; rotating it revokes them all. Without it, only the address counts. */
    HOME_COOKIE_SECRET?: string;
  }
}

export {};
