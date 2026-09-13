import { describe, expect, it } from 'vitest';
import { retryAfterMs } from './live-polling';

describe('Retry-After', () => {
  it('accepts seconds and HTTP dates', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(
      retryAfterMs('Tue, 06 Jan 2026 12:10:00 GMT', Date.parse('2026-01-06T12:00:00Z')),
    ).toBe(600_000);
    expect(retryAfterMs('0')).toBe(0);
  });

  it('ignores absent, invalid, negative and expired delays', () => {
    for (const value of [null, '', ' ', '-1', 'not a date'])
      expect(retryAfterMs(value)).toBeNull();
    expect(
      retryAfterMs('Tue, 06 Jan 2026 12:00:00 GMT', Date.parse('2026-01-06T12:01:00Z')),
    ).toBeNull();
  });
});
