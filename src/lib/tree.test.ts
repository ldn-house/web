import { describe, expect, it } from 'vitest';
import { nearness, parseManifest, treeFrame } from './tree';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    source: { commit: '511b26e7ac2610060df64497331dd91f85e731b8' },
    leds: 3,
    fps: 20,
    seed: 0,
    encoding: 'rgb8',
    frame_stage: 'raw',
    output: { applied: false },
    coords: [[0.1, 0, -0.2], null, [-0.3, 1, 0.1]],
    effects: [
      {
        name: 'candy_cane',
        label: 'Candy cane',
        frames: 2,
        file: 'candy_cane.bin',
        byte_length: 18,
        sha256: 'a'.repeat(64),
        loop: { mode: 'period' },
      },
    ],
    ...overrides,
  };
}

describe('parseManifest', () => {
  it('keeps what the panel needs and ignores additions', () => {
    const parsed = parseManifest(manifest());
    expect(parsed).toMatchObject({
      commit: '511b26e7ac2610060df64497331dd91f85e731b8',
      fps: 20,
      leds: 3,
      placed: 2,
      effects: [{ name: 'candy_cane', label: 'Candy cane', frames: 2 }],
    });
    expect(parsed.coords[1]).toBeNull();
    expect(parsed.files.get('candy_cane')).toEqual({
      file: 'candy_cane.bin',
      sha256: 'a'.repeat(64),
    });
  });

  it('refuses a format or frame stage it cannot display', () => {
    expect(() => parseManifest(manifest({ format: 2 }))).toThrow(/format/);
    expect(() => parseManifest(manifest({ frame_stage: 'output' }))).toThrow(
      /frame_stage/,
    );
    expect(() => parseManifest(manifest({ encoding: 'rgb565' }))).toThrow(/encoding/);
  });

  it('refuses file names that could leave the export directory', () => {
    const effects = [{ ...manifest().effects[0], file: '../worker.js' }];
    expect(() => parseManifest(manifest({ effects }))).toThrow(/file/);
  });

  it('refuses coordinates that do not cover every LED', () => {
    expect(() => parseManifest(manifest({ coords: [[0, 0, 0]] }))).toThrow(/coords/);
    expect(() => parseManifest(manifest({ coords: [[0, 0], null, null] }))).toThrow(
      /coords\[0\]/,
    );
  });

  it('refuses a byte length that disagrees with the frame count', () => {
    const effects = [{ ...manifest().effects[0], byte_length: 17 }];
    expect(() => parseManifest(manifest({ effects }))).toThrow(/byte_length/);
  });

  it('refuses duplicate effects', () => {
    const effect = manifest().effects[0];
    expect(() => parseManifest(manifest({ effects: [effect, effect] }))).toThrow(/twice/);
  });
});

describe('treeFrame', () => {
  it('fits the widest LED at any rotation and the full height', () => {
    const frame = treeFrame([[0.3, 0, 0.4], null, [0, 1, 0]]);
    expect(frame.radius).toBeCloseTo(0.5);
    expect(frame.left).toBeCloseTo(-frame.width / 2);
    expect(frame.top).toBeLessThan(-1);
    expect(frame.top + frame.height).toBeGreaterThan(0);
  });
});

describe('nearness', () => {
  it('brightens the front of the tree', () => {
    expect(nearness(0.5, 0.5)).toBe(1);
    expect(nearness(-0.5, 0.5)).toBeCloseTo(0.6);
  });
});
