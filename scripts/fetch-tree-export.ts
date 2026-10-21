/**
 * bun scripts/fetch-tree-export.ts [archive URL or path | export directory] [--optional]
 *
 * Fetches the tree's pre-rendered effect loops from ldn-house/tree's rolling
 * `firmware-main` release into src/tree-export/, which the build bundles as
 * static assets. Without it the tree panel is left out of the page.
 * --optional turns a failure into a warning, so a tree-side problem never
 * blocks an energy deploy.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readTar } from '../src/lib/tar';
import { frameBytes, parseManifest, type TreeIndex } from '../src/lib/tree';

const RELEASE =
  'https://github.com/ldn-house/tree/releases/download/firmware-main/tree-effects.tar.gz';
const OUT = resolve(import.meta.dirname, '../src/tree-export');
// The archive is about 350 KB and 1.9 MB unpacked; these leave room to grow
// while keeping a bad or hostile download from exhausting the runner.
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const optional = args.includes('--optional');
const source = args.find((a) => !a.startsWith('--')) ?? RELEASE;

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES)
      throw new Error(`${url}: larger than ${MAX_ARCHIVE_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

type Export = {
  read: (name: string) => Uint8Array;
  /** The archive's digest, in the form GitHub reports for release assets. */
  archive?: string;
};

/** Only names the manifest lists are read. */
async function open(): Promise<Export> {
  const path = resolve(source);
  if (!/^https?:\/\//.test(source) && lstatSync(path).isDirectory()) {
    return {
      read: (name) => {
        const file = join(path, name);
        if (!lstatSync(file).isFile()) throw new Error(`${name} is not a regular file`);
        return readFileSync(file);
      },
    };
  }
  const archive = /^https?:\/\//.test(source)
    ? await download(source)
    : readFileSync(path);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('archive is too large');
  const files = readTar(gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }));
  return {
    read: (name) => {
      const file = files.get(name);
      if (!file) throw new Error(`${name} is missing from the archive`);
      return file;
    },
    archive: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
  };
}

async function main() {
  const { read, archive } = await open();
  const manifest = parseManifest(
    JSON.parse(new TextDecoder().decode(read('manifest.json'))),
  );
  const staged = `${OUT}.tmp`;
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged);

  let raw = 0;
  let packed = 0;
  for (const effect of manifest.effects) {
    const { file, sha256 } = manifest.files.get(effect.name)!;
    const data = read(file);
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
    archive,
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
