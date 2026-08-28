/** Secrets set with `wrangler secret put`, absent from wrangler.jsonc. */
declare global {
  interface Env {
    OCTOPUS_API_KEY: string;
    /** Set only on preview deployments; absent in production, where seeding 404s. */
    SEED_TOKEN?: string;
  }
}

export {};
