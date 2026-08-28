/**
 * Creates the PR's database if it does not exist, applies migrations to it and
 * writes the preview Wrangler config. Idempotent: reruns on every push to the PR.
 */
import { writeFileSync } from 'node:fs';
import { $ } from 'bun';
import { PREVIEW_CONFIG_PATH, previewConfig, previewNames } from './config';

const pr = process.env.PR_NUMBER;
if (!pr) throw new Error('PR_NUMBER not set');
const seedToken = process.env.SEED_TOKEN;
if (!seedToken) throw new Error('SEED_TOKEN not set');
const { database } = previewNames(pr);

async function databaseId(): Promise<string | null> {
  const result = await $`bunx wrangler d1 info ${database} --json`.quiet().nothrow();
  if (result.exitCode !== 0) return null;
  return (JSON.parse(result.stdout.toString()) as { uuid: string }).uuid;
}

let id = await databaseId();
if (id) {
  console.log(`reusing ${database}`);
} else {
  console.log(`creating ${database}`);
  await $`bunx wrangler d1 create ${database}`;
  id = await databaseId();
  if (!id) throw new Error(`created ${database} but could not read its id back`);
}

writeFileSync(
  PREVIEW_CONFIG_PATH,
  `${JSON.stringify(previewConfig(pr, id, seedToken), null, 2)}\n`,
);
await $`bunx wrangler d1 migrations apply ${database} --remote --config ${PREVIEW_CONFIG_PATH}`.env(
  {
    ...process.env,
    CI: 'true',
  },
);
console.log(`provisioned ${database} (${id})`);
