import { describe, expect, it } from 'vitest';
import { mergeConsumption } from './consumption';
import { costForSlot, type UsageRate } from './cost';

const start = '2026-01-06T12:00:00Z';
const end = '2026-01-06T12:30:00Z';
const rate = (pIncVat: number): UsageRate => ({ from: start, to: end, pIncVat });

describe('costForSlot', () => {
  it('uses the matching rate including VAT without rounding kWh or cost', () => {
    const slot = { start: '2026-01-06T12:00:00.000Z', kwh: 0.123456 };
    expect(
      costForSlot(slot, [
        rate(25.1234),
        { from: end, to: '2026-01-06T13:00:00Z', pIncVat: 99 },
      ]),
    ).toEqual({
      gbp: (0.123456 * 25.1234) / 100,
      pIncVat: 25.1234,
    });
  });

  it('prices partial consumption as recorded, then uses billing when it arrives', () => {
    const live = { start, through: '2026-01-06T12:08:00Z', kwh: 0.12 };
    const partial = mergeConsumption([], [], [live], start, end)[0]!;
    expect(costForSlot(partial, [rate(25)])?.gbp).toBe(0.03);
    const billed = mergeConsumption([{ start, kwh: 0.4 }], [], [live], start, end)[0]!;
    expect(costForSlot(billed, [rate(25)])?.gbp).toBe(0.1);
  });

  it('preserves free, zero-consumption and negative-price periods', () => {
    expect(costForSlot({ start, kwh: 0.4 }, [rate(0)])?.gbp).toBe(0);
    expect(costForSlot({ start, kwh: 0 }, [rate(25)])?.gbp).toBe(0);
    expect(costForSlot({ start, kwh: 0.4 }, [rate(-5)])?.gbp).toBe(-0.02);
  });

  it('leaves missing, incomplete or conflicting prices unknown', () => {
    const slot = { start, kwh: 0.4 };
    expect(costForSlot(slot, [])).toBeNull();
    expect(costForSlot(slot, [{ ...rate(25), to: '2026-01-06T12:15:00Z' }])).toBeNull();
    expect(costForSlot(slot, [rate(25), rate(30)])).toBeNull();
    expect(costForSlot(slot, [rate(25), rate(25)])?.gbp).toBe(0.1);
  });

  it('matches UTC instants through the repeated London hour', () => {
    const rates = [
      { from: '2026-10-25T00:00:00Z', to: '2026-10-25T00:30:00Z', pIncVat: 20 },
      { from: '2026-10-25T01:00:00Z', to: '2026-10-25T01:30:00Z', pIncVat: 30 },
    ];
    expect(costForSlot({ start: '2026-10-25T01:00:00+01:00', kwh: 1 }, rates)?.gbp).toBe(
      0.2,
    );
    expect(costForSlot({ start: '2026-10-25T01:00:00Z', kwh: 1 }, rates)?.gbp).toBe(0.3);
  });
});
