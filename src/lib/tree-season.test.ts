import { describe, expect, it } from 'vitest';
import { inTreeSeason } from './tree-season';

// London is on GMT for the whole season, so these are also UTC instants.
const at = (iso: string) => Date.parse(iso);

describe('inTreeSeason', () => {
  it('starts at midnight on 1 December, London time', () => {
    expect(inTreeSeason(at('2026-11-30T23:59:59Z'))).toBe(false);
    expect(inTreeSeason(at('2026-12-01T00:00:00Z'))).toBe(true);
  });

  it('ends after 6 January, London time', () => {
    expect(inTreeSeason(at('2027-01-06T23:59:59Z'))).toBe(true);
    expect(inTreeSeason(at('2027-01-07T00:00:00Z'))).toBe(false);
  });

  it('wraps the new year', () => {
    expect(inTreeSeason(at('2026-12-31T23:59:59Z'))).toBe(true);
    expect(inTreeSeason(at('2027-01-01T00:00:00Z'))).toBe(true);
  });

  it('goes by the date in London, not where the instant was written', () => {
    // 30 November in California is already 1 December in London.
    expect(inTreeSeason(at('2026-11-30T20:00:00-08:00'))).toBe(true);
  });

  it('is out of season the rest of the year', () => {
    expect(inTreeSeason(at('2026-10-20T12:00:00Z'))).toBe(false);
    expect(inTreeSeason(at('2026-07-01T00:00:00Z'))).toBe(false);
  });
});
