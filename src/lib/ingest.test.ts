import { describe, expect, it } from 'bun:test';
import { toUtcIso } from './ingest';

describe('toUtcIso', () => {
  it('converts a BST offset to the equivalent UTC instant', () => {
    // Octopus returns consumption in local time; 01:00+01:00 is midnight UTC.
    expect(toUtcIso('2026-08-27T01:00:00+01:00')).toBe('2026-08-27T00:00:00Z');
  });

  it('leaves an already-UTC timestamp alone', () => {
    expect(toUtcIso('2025-12-10T10:30:00Z')).toBe('2025-12-10T10:30:00Z');
  });

  it('drops milliseconds so all stored timestamps share one format', () => {
    expect(toUtcIso('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00Z');
  });

  it('keeps GMT and BST readings mutually ordered', () => {
    const winter = toUtcIso('2026-01-15T12:00:00Z');
    const summer = toUtcIso('2026-07-15T12:00:00+01:00');
    expect(winter < summer).toBe(true);
  });

  it('rejects a timestamp it cannot parse', () => {
    expect(() => toUtcIso('not a date')).toThrow(TypeError);
  });
});
