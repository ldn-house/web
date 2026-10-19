/**
 * bun scripts/fetch-tree-export.ts [archive URL or path | export directory] [--optional]
 *
 * Fetches the tree's pre-rendered effect loops from ldn-house/tree's rolling
 * `firmware-main` release into src/tree-export/, which the build bundles as
 * static assets. Without it the tree panel is left out of the page.
 * --optional turns a failure into a warning, so a tree-side problem never
 * blocks an energy deploy.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { frameBytes, parseManifest, type TreeIndex } from '../src/lib/tree';

const RELEASE =
  'https://github.com/ldn-house/tree/releases/download/firmware-main/tree-effects.tar.gz';
const OUT = resolve(import.meta.dirname, '../src/tree-export');

const args = process.argv.slice(2);
const optional = args.includes('--optional');
const source = args.find((a) => !a.startsWith('--')) ?? RELEASE;

async function unpack(work: string): Promise<string> {
  let archive = resolve(source);
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    archive = join(work, 'archive.tar.gz');
    writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
  } else if (lstatSync(archive).isDirectory()) {
    return archive;
  }
  const dir = join(work, 'export');
  mkdirSync(dir);
  const tar = spawnSync('tar', ['-xzf', archive, '-C', dir], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return dir;
}

/** Only plain files the manifest names are read; anything else in the archive is ignored. */
function readPlain(dir: string, name: string): Buffer {
  const path = join(dir, name);
  if (!lstatSync(path).isFile()) throw new Error(`${name} is not a regular file`);
  return readFileSync(path);
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'tree-export-'));
  try {
    const dir = await unpack(work);
    const manifest = parseManifest(
      JSON.parse(readPlain(dir, 'manifest.json').toString()),
    );
    const staged = `${OUT}.tmp`;
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged);

    let raw = 0;
    let packed = 0;
    for (const effect of manifest.effects) {
      const { file, sha256 } = manifest.files.get(effect.name)!;
      const data = readPlain(dir, file);
      const expected = frameBytes(manifest.leds, effect.frames);
      if (data.length !== expected) {
        throw new Error(`${effect.name}: ${data.length} bytes, expected ${expected}`);
      }
      if (sha256 && createHash('sha256').update(data).digest('hex') !== sha256) {
        throw new Error(`${effect.name}: sha256 does not match the manifest`);
      }
      // Static assets are served without on-the-fly compression for binary
      // types, so frames ship gzipped and the player inflates them.
      const gz = gzipSync(data, { level: 9 });
      writeFileSync(join(staged, `${effect.name}.frames`), gz);
      raw += data.length;
      packed += gz.length;
      console.log(
        `${effect.name.padEnd(16)} ${effect.frames} frames  ${gz.length} bytes gzipped`,
      );
    }

    const index: TreeIndex = {
      format: 1,
      commit: manifest.commit,
      fps: manifest.fps,
      leds: manifest.leds,
      placed: manifest.placed,
      effects: manifest.effects,
    };
    writeFileSync(join(staged, 'index.json'), `${JSON.stringify(index)}\n`);
    writeFileSync(join(staged, 'coords.json'), `${JSON.stringify(manifest.coords)}\n`);

    rmSync(OUT, { recursive: true, force: true });
    renameSync(staged, OUT);
    console.log(
      `tree export ${manifest.commit.slice(0, 7)}: ${manifest.effects.length} effects, ` +
        `${raw} bytes raw, ${packed} gzipped -> ${OUT}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!optional) throw error;
  console.log(
    process.env.GITHUB_ACTIONS
      ? `::warning title=Tree export unavailable::${message}; building without the tree panel`
      : `tree export unavailable (${message}); building without the tree panel`,
  );
  if (existsSync(OUT)) console.log(`keeping the previous export in ${OUT}`);
}
