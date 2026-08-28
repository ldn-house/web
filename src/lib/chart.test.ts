import { describe, expect, it } from 'vitest';
import { linearScale, niceCeiling, stepPath, tickIndices, ticks } from './chart';

describe('linearScale', () => {
  it('maps a domain onto an inverted range, as SVG y needs', () => {
    const y = linearScale([0, 10], [100, 0]);
    expect(y(0)).toBe(100);
    expect(y(10)).toBe(0);
    expect(y(5)).toBe(50);
  });

  it('collapses to the range start when the domain is empty', () => {
    expect(linearScale([5, 5], [0, 100])(5)).toBe(0);
  });
});

describe('niceCeiling', () => {
  it('rounds up to a readable axis maximum', () => {
    expect(niceCeiling(0.82)).toBeCloseTo(0.9);
    expect(niceCeiling(47)).toBe(50);
    expect(niceCeiling(0)).toBe(1);
  });
});

describe('ticks', () => {
  it('spans zero to max inclusive', () => {
    expect(ticks(1, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

describe('tickIndices', () => {
  it('always includes the first point', () => {
    expect(tickIndices(96, 6)[0]).toBe(0);
  });

  it('never returns an index past the end', () => {
    const idx = tickIndices(7, 6);
    expect(Math.max(...idx)).toBeLessThan(7);
  });

  it('handles an empty series', () => {
    expect(tickIndices(0)).toEqual([]);
  });
});

describe('stepPath', () => {
  it('holds each value until the next point, then to the end', () => {
    // Agile prices are flat across a half-hour, so a sloped line would misread.
    expect(
      stepPath(
        [
          { x: 0, y: 10 },
          { x: 5, y: 4 },
        ],
        10,
      ),
    ).toBe('M 0 10 L 5 10 L 5 4 L 10 4');
  });

  it('returns nothing for an empty series', () => {
    expect(stepPath([], 10)).toBe('');
  });
});
