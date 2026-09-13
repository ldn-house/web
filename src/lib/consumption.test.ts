import { describe, expect, it } from 'vitest';
import { isPartialSlot, mergeConsumption, meterSlots } from './consumption';

describe('meter consumption', () => {
  it('keeps energy in its reported interval, including a zero and an unfinished half-hour', () => {
    const slots = meterSlots(
      [
        { readAt: '2026-01-06T11:00:00Z', consumptionDelta: '250' },
        { readAt: '2026-01-06T11:30:00Z', consumptionDelta: '0' },
        { readAt: '2026-01-06T12:00:00Z', consumptionDelta: '80' },
      ],
      '2026-01-06T12:10:20Z',
    );
    expect(slots).toEqual([
      {
        start: '2026-01-06T11:00:00.000Z',
        kwh: 0.25,
        through: '2026-01-06T11:30:00.000Z',
      },
      { start: '2026-01-06T11:30:00.000Z', kwh: 0, through: '2026-01-06T12:00:00.000Z' },
      {
        start: '2026-01-06T12:00:00.000Z',
        kwh: 0.08,
        through: '2026-01-06T12:10:20.000Z',
      },
    ]);
    expect(slots.map(isPartialSlot)).toEqual([false, false, true]);
  });

  it('omits missing, invalid, negative, misaligned, and future readings rather than inventing usage', () => {
    const readings = [undefined, null, '', 'NaN', 'Infinity', '-1'].map(
      (consumptionDelta) => ({
        readAt: '2026-01-06T12:00:00Z',
        consumptionDelta,
      }),
    );
    expect(
      meterSlots(
        [
          ...readings,
          { readAt: 'invalid', consumptionDelta: '100' },
          { readAt: '2026-01-06T12:05:00Z', consumptionDelta: '100' },
          { readAt: '2026-01-06T12:30:00Z', consumptionDelta: '100' },
        ],
        '2026-01-06T12:10:00Z',
      ),
    ).toEqual([]);
  });

  it('replaces a partial reading at rollover without adding the same energy twice', () => {
    const earlier = meterSlots(
      [{ readAt: '2026-01-06T12:00:00Z', consumptionDelta: '80' }],
      '2026-01-06T12:10:00Z',
    );
    const later = meterSlots(
      [
        { readAt: '2026-01-06T12:00:00Z', consumptionDelta: '250' },
        { readAt: '2026-01-06T12:30:00Z', consumptionDelta: '10' },
      ],
      '2026-01-06T12:31:00Z',
    );
    const merged = mergeConsumption(
      [],
      earlier,
      later,
      '2026-01-06T00:00:00Z',
      '2026-01-07T00:00:00Z',
    );
    expect(merged.map((slot) => slot.kwh)).toEqual([0.25, 0.01]);
    expect(merged.map(isPartialSlot)).toEqual([false, true]);
    // A delayed response cannot turn the completed bucket back into the old partial one.
    expect(
      mergeConsumption(
        [],
        later,
        earlier,
        '2026-01-06T00:00:00Z',
        '2026-01-07T00:00:00Z',
      ),
    ).toEqual(merged);
  });

  it('uses billing for overlaps, fills gaps, and treats equivalent UTC timestamps as the same period', () => {
    const meter = meterSlots(
      [
        { readAt: '2026-01-06T12:00:00Z', consumptionDelta: '250' },
        { readAt: '2026-01-06T12:30:00Z', consumptionDelta: '200' },
        { readAt: '2026-01-06T13:00:00Z', consumptionDelta: '100' },
      ],
      '2026-01-06T14:00:00Z',
    );
    const merged = mergeConsumption(
      [{ start: '2026-01-06T12:00:00Z', kwh: 0.26 }],
      meter,
      [],
      '2026-01-06T12:00:00Z',
      '2026-01-06T13:00:00Z',
    );
    expect(merged.map(({ kwh, source }) => ({ kwh, source }))).toEqual([
      { kwh: 0.26, source: 'billing' },
      { kwh: 0.2, source: 'meter' },
    ]);
  });

  it('preserves partial coverage during an outage and keeps both repeated London half-hours at DST', () => {
    const meter = meterSlots(
      [
        { readAt: '2026-10-25T01:00:00+01:00', consumptionDelta: '200' },
        { readAt: '2026-10-25T01:00:00Z', consumptionDelta: '100' },
      ],
      '2026-10-25T01:10:00Z',
    );
    const merged = mergeConsumption(
      [],
      meter,
      [],
      '2026-10-24T23:00:00Z',
      '2026-10-26T00:00:00Z',
    );
    expect(merged).toHaveLength(2);
    expect(merged.map(isPartialSlot)).toEqual([false, true]);
    expect(merged[1]!.through).toBe('2026-10-25T01:10:00.000Z');
  });
});
