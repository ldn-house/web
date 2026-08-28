/** Secrets set with `wrangler secret put`, absent from wrangler.jsonc. */
declare global {
  interface Env {
    OCTOPUS_API_KEY: string;
  }
}

export {};
