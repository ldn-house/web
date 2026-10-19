import { describe, expect, it } from 'vitest';
import { cheapestWindow, rateAt, spendSince } from './headline';

const midnight = '2026-10-18T23:00:00Z';
const at = (minutes: number) =>
  new Date(Date.parse(midnight) + minutes * 60_000).toISOString();
const slot = (minutes: number, kwh: number, through = minutes + 30) => ({
  start: at(minutes),
  kwh,
  through: at(through),
});
const usageRate = (minutes: number, pIncVat: number) => ({
  from: at(minutes),
  to: at(minutes + 30),
  pIncVat,
});

describe('spendSince', () => {
  it('prices each half-hour at its own rate, including the one in progress', () => {
    const spend = spendSince(
      midnight,
      [slot(-30, 9), slot(0, 1), slot(30, 0.5), slot(60, 0.2, 70)],
      [usageRate(-30, 99), usageRate(0, 20), usageRate(30, 30), usageRate(60, -10)],
    );
    expect(spend.kwh).toBeCloseTo(1.7);
    expect(spend.gbp).toBeCloseTo((1 * 20 + 0.5 * 30 - 0.2 * 10) / 100);
    expect(spend.through).toBe(at(70));
    expect(spend.missing).toBe(0);
    expect(spend.unpriced).toBe(0);
  });

  it('counts gaps and unpriced readings instead of hiding them', () => {
    const spend = spendSince(midnight, [slot(0, 1), slot(90, 1)], [usageRate(0, 20)]);
    expect(spend.gbp).toBeCloseTo(0.2);
    expect(spend.kwh).toBe(2);
    expect(spend.missing).toBe(2);
    expect(spend.unpriced).toBe(1);
  });

  it('has no coverage before the first reading of the day', () => {
    expect(spendSince(midnight, [slot(-30, 1)], [])).toEqual({
      gbp: 0,
      kwh: 0,
      through: null,
      missing: 0,
      unpriced: 0,
    });
  });
});

const rate = (minutes: number, pIncVat: number) => ({ start: at(minutes), pIncVat });

describe('rateAt', () => {
  it('finds the half-hour containing an instant', () => {
    const rates = [rate(0, 10), rate(30, 20)];
    expect(rateAt(rates, Date.parse(at(29)))?.pIncVat).toBe(10);
    expect(rateAt(rates, Date.parse(at(30)))?.pIncVat).toBe(20);
    expect(rateAt(rates, Date.parse(at(60)))).toBeUndefined();
  });
});

describe('cheapestWindow', () => {
  const rates = [30, 10, 40, 12, 11, 50].map((p, i) => rate(i * 30, p));

  it('finds the lowest average over consecutive half-hours ahead', () => {
    expect(cheapestWindow(rates, Date.parse(at(0)), 1)).toEqual({
      start: at(30),
      end: at(60),
      average: 10,
    });
    expect(cheapestWindow(rates, Date.parse(at(0)), 2)).toEqual({
      start: at(90),
      end: at(150),
      average: 11.5,
    });
  });

  it('prices a window starting now by the time left in this half-hour', () => {
    const steep = [1, 1, 100, 5, 5].map((p, i) => rate(i * 30, p));
    expect(cheapestWindow(steep, Date.parse(at(29)), 2)).toEqual({
      start: at(90),
      end: at(150),
      average: 5,
    });
    const flat = [5, 5, 5, 50].map((p, i) => rate(i * 30, p));
    expect(cheapestWindow(flat, Date.parse(at(10)), 2)).toEqual({
      start: at(10),
      end: at(70),
      average: 5,
    });
    expect(cheapestWindow(rates, Date.parse(at(45)), 1)?.start).toBe(at(120));
  });

  it('does not bridge a gap in published rates', () => {
    const gappy = [rate(0, 50), rate(30, 1), rate(90, 1), rate(120, 50)];
    expect(cheapestWindow(gappy, Date.parse(at(0)), 2)?.start).toBe(at(0));
  });

  it('prefers the earliest of equal windows and needs enough rates', () => {
    const flat = [rate(0, 5), rate(30, 5), rate(60, 5)];
    expect(cheapestWindow(flat, Date.parse(at(0)), 2)?.start).toBe(at(0));
    expect(cheapestWindow(flat, Date.parse(at(0)), 4)).toBeUndefined();
    const rounding = [15.15, 15.15, 100, 10.1, 20.2].map((p, i) => rate(i * 30, p));
    expect(cheapestWindow(rounding, Date.parse(at(0)), 2)?.start).toBe(at(0));
  });
});
