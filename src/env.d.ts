/** Secrets set with `wrangler secret put`, absent from wrangler.jsonc. */
declare global {
  interface Env {
    OCTOPUS_API_KEY: string;
    /** Set only on preview deployments; absent in production, where seeding 404s. */
    SEED_TOKEN?: string;
    /** Home Assistant's bearer token for `/api/home/*`; those routes 404 without it. */
    HOME_ASSISTANT_TOKEN?: string;
    /** Home Assistant's local-only enrolment webhook, as reachable from the house's LAN. */
    HOME_ASSISTANT_WEBHOOK_URL?: string;
    /** Signs home and enrolment cookies; rotating it revokes them all. */
    HOME_COOKIE_SECRET?: string;
  }
}

export {};
