/**
 * bun scripts/smoke-server.ts
 *
 * Serves the built artifact in dist/ in workerd for the browser smoke test
 * (e2e/, run by `bun run test:smoke`), with a fresh local database seeded from
 * the captured fixture. Run `bun run build` first. Prints "smoke server ready"
 * once seeded, then serves until stopped.
 *
 * Nothing here reaches Octopus or Home Assistant: seeding replays the fixture,
 * OCTOPUS_API_KEY is empty so /api/live-power answers 204, and cron triggers
 * do not fire under `wrangler dev`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { $ } from 'bun';

const root = resolve(import.meta.dirname, '..');
const config = resolve(root, 'dist/ldn_house/wrangler.json');
const state = resolve(root, '.wrangler/smoke');
const envFile = resolve(state, 'smoke.env');
const port = Number(process.env.SMOKE_PORT ?? 8790);
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const seedToken = crypto.randomUUID();
const DAY_MS = 86_400_000;

if (!existsSync(config)) throw new Error(`${config} not found; run \`bun run build\``);

rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
// An explicit env file stops wrangler reading .dev.vars, which the build copies
// into dist/ from a developer's checkout and may hold real credentials.
writeFileSync(envFile, `SEED_TOKEN=${seedToken}\nOCTOPUS_API_KEY=\n`);
const env = {
  ...process.env,
  CI: 'true',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true',
};

await $`bunx wrangler d1 migrations apply DB --local --persist-to ${state} --config ${config}`
  .env(env)
  .quiet();

// --local-upstream keeps the Worker seeing 127.0.0.1 rather than the production
// route, so it behaves as a local server: `?as=` and `?at=` apply, and robots.txt
// disallows everything.
const server = Bun.spawn(
  [
    'bunx',
    'wrangler',
    'dev',
    '--config',
    config,
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--local-upstream',
    host,
    '--persist-to',
    state,
    '--env-file',
    envFile,
    '--show-interactive-dev-session=false',
  ],
  { env, stdout: 'inherit', stderr: 'inherit' },
);
const stop = () => server.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.exited.then((code) => process.exit(code ?? 1));

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const ok = await fetch(`${origin}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await Bun.sleep(1000);
  }
  throw new Error(`${origin}/api/health did not answer within 60s`);
}

/**
 * The page always renders around the server's real clock, so the fixture moves
 * forward by whole days until its last reading ends within the past day. That
 * leaves yesterday's usage and today's and tomorrow's rates populated.
 */
function shiftedFixture() {
  const fixture = JSON.parse(
    readFileSync(resolve(root, 'src/fixtures/octopus.json'), 'utf8'),
  ) as { consumption: { interval_end: string }[] };
  const lastEnd = Math.max(...fixture.consumption.map((c) => Date.parse(c.interval_end)));
  const shift = Math.floor((Date.now() - lastEnd) / DAY_MS) * DAY_MS;
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
  return JSON.stringify(fixture, (_key, value) =>
    typeof value === 'string' && timestamp.test(value)
      ? new Date(Date.parse(value) + shift).toISOString().replace('.000Z', 'Z')
      : value,
  );
}

try {
  await waitForHealth();
  const seeded = await fetch(`${origin}/api/seed`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${seedToken}`, 'Content-Type': 'application/json' },
    body: shiftedFixture(),
  });
  if (!seeded.ok) throw new Error(`seed failed: ${seeded.status} ${await seeded.text()}`);
  console.log('seeded', await seeded.text());
  console.log(`smoke server ready at ${origin}`);
} catch (error) {
  stop();
  throw error;
}
