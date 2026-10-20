import { describe, expect, it } from 'vitest';
import { readTar } from './tar';

function entry(name: string, body: string, type = '0', prefix = '') {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0);
  header.set(enc.encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
  header[156] = type.charCodeAt(0);
  header.set(enc.encode(prefix), 345);
  const data = new Uint8Array(Math.ceil(body.length / 512) * 512);
  data.set(enc.encode(body));
  return [header, data];
}

function tar(...entries: Uint8Array[][]) {
  const parts = [...entries.flat(), new Uint8Array(1024)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe('readTar', () => {
  it('reads flat regular files and skips pax headers', () => {
    const files = readTar(
      tar(
        entry('PaxHeader', 'x', 'x'),
        entry('manifest.json', '{}'),
        entry('a.bin', 'abc'),
      ),
    );
    expect([...files.keys()]).toEqual(['manifest.json', 'a.bin']);
    expect(new TextDecoder().decode(files.get('a.bin'))).toBe('abc');
  });

  it('refuses paths, links and directories', () => {
    expect(() => readTar(tar(entry('../worker.js', '')))).toThrow(/unexpected entry/);
    expect(() => readTar(tar(entry('a.bin', '', '0', 'dir')))).toThrow(
      /unexpected entry/,
    );
    expect(() => readTar(tar(entry('a.bin', '', '2')))).toThrow(/not a regular file/);
    expect(() => readTar(tar(entry('dir', '', '5')))).toThrow(/not a regular file/);
  });

  it('refuses truncated archives and too many entries', () => {
    const whole = tar(entry('a.bin', 'x'.repeat(600)));
    expect(() => readTar(whole.subarray(0, 700))).toThrow(/truncated/);
    expect(() => readTar(tar(entry('a.bin', ''), entry('b.bin', '')), 1)).toThrow(
      /more than 1/,
    );
  });
});
