import { readFileSync } from 'node:fs';
import JSON5 from 'json5';

export const PREVIEW_CONFIG_PATH = 'wrangler.preview.json';

export function previewNames(pr: string | number) {
  return { worker: `ldn-house-pr-${pr}`, database: `ldn-house-pr-${pr}` };
}

/**
 * Derives a preview config from the committed one so the two cannot drift.
 * Routes and cron triggers are dropped: a preview must not answer on
 * preview.ldn.house, and every open PR running the ingest would hammer Octopus.
 */
export function previewConfig(
  pr: string | number,
  databaseId: string,
  seedToken: string,
) {
  const base = JSON5.parse(readFileSync('wrangler.jsonc', 'utf8')) as Record<
    string,
    unknown
  >;
  const names = previewNames(pr);
  const databases = base.d1_databases as { binding: string }[];

  return {
    ...base,
    name: names.worker,
    routes: undefined,
    triggers: undefined,
    d1_databases: databases.map((d) => ({
      ...d,
      database_name: names.database,
      database_id: databaseId,
    })),
    // A var rather than a secret, so it lands atomically with the deploy. It
    // only authorises seeding a throwaway preview database.
    vars: { ...(base.vars as object), SEED_TOKEN: seedToken },
  };
}
