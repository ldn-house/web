const BLOCK = 512;

function text(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

/**
 * Reads the regular files of an uncompressed ustar/pax archive into memory.
 * Only flat names are accepted: anything with a directory, a link or another
 * entry type is refused rather than skipped, since the export has none.
 * Pax extended headers are skipped; the export's names never need them.
 */
export function readTar(archive: Uint8Array, maxEntries = 64): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const size = Number.parseInt(text(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error(`tar: bad size for ${name}`);
    const start = offset + BLOCK;
    if (start + size > archive.length) throw new Error(`tar: ${name} is truncated`);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x' || type === 'g') continue;
    if (type !== '0' && type !== '\0')
      throw new Error(`tar: ${name} is not a regular file`);
    if (prefix || !/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
      throw new Error(`tar: unexpected entry ${JSON.stringify(prefix + name)}`);
    }
    if (files.has(name)) throw new Error(`tar: ${name} appears twice`);
    if (files.size >= maxEntries) throw new Error(`tar: more than ${maxEntries} entries`);
    files.set(name, archive.subarray(start, start + size));
  }
  return files;
}
