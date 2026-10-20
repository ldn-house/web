/**
 * bun scripts/tree-export-changed.ts [--published <sha256:…>] [--deployed <sha256:… | none>] [--site <url>]
 *
 * Compares the tree export on ldn-house/tree's `firmware-main` release with
 * the one production reports building from at /api/health, and writes
 * `changed=true|false` to $GITHUB_OUTPUT. A release without a usable export
 * is never a change; production without one is.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import JSON5 from 'json5';

const RELEASE_API =
  'https://api.github.com/repos/ldn-house/tree/releases/tags/firmware-main';
const ASSET = 'tree-effects.tar.gz';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function productionSite(): string {
  const config = JSON5.parse(readFileSync('wrangler.jsonc', 'utf8')) as {
    routes?: { pattern: string; custom_domain?: boolean }[];
  };
  const route = config.routes?.find((r) => r.custom_domain);
  if (!route) throw new Error('wrangler.jsonc has no custom domain route');
  return `https://${route.pattern}`;
}

async function json(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function published(): Promise<string | undefined> {
  const given = option('--published');
  if (given !== undefined) return DIGEST.test(given) ? given : undefined;
  const token = process.env.GITHUB_TOKEN;
  const release = (await json(RELEASE_API, {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  })) as { assets?: { name: string; state?: string; digest?: string | null }[] };
  const asset = release.assets?.find((a) => a.name === ASSET);
  if (!asset || (asset.state && asset.state !== 'uploaded')) return undefined;
  return asset.digest && DIGEST.test(asset.digest) ? asset.digest : undefined;
}

async function deployed(): Promise<string | null> {
  const given = option('--deployed');
  if (given !== undefined) return given === 'none' ? null : given;
  const site = option('--site') ?? productionSite();
  const health = (await json(`${site}/api/health`)) as {
    ok?: boolean;
    treeExport?: unknown;
  };
  if (health.ok !== true) throw new Error(`${site}/api/health is not ok`);
  return typeof health.treeExport === 'string' ? health.treeExport : null;
}

const [latest, current] = await Promise.all([published(), deployed()]);
const changed = latest !== undefined && latest !== current;
console.log(`published ${latest ?? 'unavailable'}`);
console.log(`deployed  ${current ?? 'none'}`);
if (latest === undefined) {
  console.log(
    `${process.env.GITHUB_ACTIONS ? '::warning::' : ''}the release has no ${ASSET} digest; not redeploying`,
  );
} else {
  console.log(changed ? 'changed' : 'unchanged');
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
