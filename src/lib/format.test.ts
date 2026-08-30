import { describe, expect, it } from 'vitest';
import { addLondonDays, dayTicks, londonMidnight } from './format';

describe('londonMidnight', () => {
  it('is 23:00Z the previous day under BST', () => {
    expect(londonMidnight('2026-07-15T10:00:00Z')).toBe('2026-07-14T23:00:00Z');
  });

  it('is 00:00Z under GMT', () => {
    expect(londonMidnight('2026-01-15T10:00:00Z')).toBe('2026-01-15T00:00:00Z');
  });

  it('handles an instant just after a BST midnight', () => {
    expect(londonMidnight('2026-07-14T23:30:00Z')).toBe('2026-07-14T23:00:00Z');
  });
});

describe('addLondonDays', () => {
  it('crosses the spring clock change with a 23-hour day', () => {
    // BST begins 2026-03-29.
    expect(addLondonDays('2026-03-28T00:00:00Z', 2)).toBe('2026-03-29T23:00:00Z');
  });
});

describe('dayTicks', () => {
  it('labels midnights with the day and noons as 12:00', () => {
    const ticks = dayTicks('2026-01-15T00:00:00Z', '2026-01-17T00:00:00Z');
    expect(ticks.map((t) => [t.label, t.major])).toEqual([
      ['Thu 15 Jan', true],
      ['12:00', false],
      ['Fri 16 Jan', true],
      ['12:00', false],
    ]);
  });
});
