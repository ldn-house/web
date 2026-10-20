/** An LED position in the tree's frame: y 0..1 from the lowest LED, x and z around the trunk. */
export type Point = readonly [x: number, y: number, z: number];

export type TreeEffect = {
  name: string;
  label: string;
  frames: number;
};

/** What the build keeps from the tree repo's `manifest.json`, minus coordinates. */
export type TreeIndex = {
  format: 1;
  commit: string;
  fps: number;
  leds: number;
  /** LEDs with a calibrated position. */
  placed: number;
  effects: readonly TreeEffect[];
};

export type TreeExport = TreeIndex & { coords: readonly (Point | null)[] };

const NAME = /^[a-z0-9_]+$/;
const MAX_LEDS = 2_000;
const MAX_FRAMES = 10_000;

/** Bytes of one effect's frame data: frames × leds × RGB. */
export function frameBytes(leds: number, frames: number): number {
  return frames * leds * 3;
}

function fail(message: string): never {
  throw new Error(`tree export: ${message}`);
}

function integer(value: unknown, what: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${what} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

export type FrameSource = { file: string; sha256?: string };

/**
 * Validates the exporter's manifest (ldn-house/tree docs/web-export.md) and
 * refuses anything that does not match format 1. Fields it does not use are
 * ignored, so the exporter can add to the format without breaking the build.
 */
export function parseManifest(
  json: unknown,
): TreeExport & { files: Map<string, FrameSource> } {
  if (typeof json !== 'object' || json === null) fail('manifest is not an object');
  const m = json as Record<string, unknown>;
  if (m.format !== 1) fail(`unsupported format ${JSON.stringify(m.format)}`);
  if (m.encoding !== 'rgb8') fail(`unsupported encoding ${JSON.stringify(m.encoding)}`);
  // The player applies its own display transform to raw effect output.
  if (m.frame_stage !== 'raw')
    fail(`unsupported frame_stage ${JSON.stringify(m.frame_stage)}`);
  const fps = integer(m.fps, 'fps', 1, 120);
  const leds = integer(m.leds, 'leds', 1, MAX_LEDS);
  const source = m.source as Record<string, unknown> | undefined;
  const commit = typeof source?.commit === 'string' ? source.commit : '';
  if (!/^[0-9a-f]{7,40}$/.test(commit)) fail('source.commit must be a git sha');

  if (!Array.isArray(m.coords) || m.coords.length !== leds) {
    fail(`coords must list exactly ${leds} entries`);
  }
  const coords = m.coords.map((c, i): Point | null => {
    if (c === null) return null;
    if (
      !Array.isArray(c) ||
      c.length !== 3 ||
      !c.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 10)
    ) {
      fail(`coords[${i}] must be [x, y, z] or null`);
    }
    return [c[0], c[1], c[2]];
  });
  const placed = coords.filter(Boolean).length;
  if (!placed) fail('no LED has a position');

  if (!Array.isArray(m.effects) || m.effects.length === 0)
    fail('effects must be non-empty');
  const files = new Map<string, FrameSource>();
  const effects = m.effects.map((e: unknown, i): TreeEffect => {
    const effect = (e ?? {}) as Record<string, unknown>;
    const name = effect.name;
    if (typeof name !== 'string' || !NAME.test(name))
      fail(`effects[${i}].name is invalid`);
    if (files.has(name)) fail(`effect ${name} is listed twice`);
    const label = effect.label;
    if (typeof label !== 'string' || !label.trim() || label.length > 40) {
      fail(`effects[${i}].label is invalid`);
    }
    const file = effect.file;
    if (typeof file !== 'string' || !/^[a-z0-9_]+\.bin$/.test(file)) {
      fail(`effects[${i}].file is invalid`);
    }
    const frames = integer(effect.frames, `${name} frames`, 1, MAX_FRAMES);
    if (
      effect.byte_length !== undefined &&
      effect.byte_length !== frameBytes(leds, frames)
    ) {
      fail(`${name} byte_length does not match frames × leds × 3`);
    }
    const sha256 = effect.sha256;
    if (
      sha256 !== undefined &&
      (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    ) {
      fail(`${name} sha256 is invalid`);
    }
    files.set(name, { file, sha256 });
    return { name, label: label.trim(), frames };
  });

  return { format: 1, commit, fps, leds, placed, coords, effects, files };
}

/**
 * The front view, shared by the server SVG and the player so the swap between
 * them does not move a single LED. Units are the tree's own; the vertical
 * span covers the whole height, the horizontal one the widest LED at any
 * rotation about the trunk.
 */
export type Frame = {
  radius: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

const MARGIN = 0.06;

export function treeFrame(coords: readonly (Point | null)[]): Frame {
  let radius = 0.05;
  for (const c of coords) if (c) radius = Math.max(radius, Math.hypot(c[0], c[2]));
  const halfWidth = radius + MARGIN;
  return {
    radius,
    left: -halfWidth,
    top: -(1 + MARGIN),
    width: 2 * halfWidth,
    height: 1 + 2 * MARGIN,
  };
}

/** Nearer LEDs read slightly brighter; 1 at the front edge, 0.6 at the back. */
export function nearness(z: number, radius: number): number {
  return 0.6 + 0.4 * ((z / radius + 1) / 2);
}
