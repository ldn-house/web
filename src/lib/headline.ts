import { HALF_HOUR_MS, type MeterSlot } from './consumption';
import { costForSlot, type UsageRate } from './cost';

export interface RatePeriod {
  start: string;
  pIncVat: number;
}

export interface Spend {
  gbp: number;
  kwh: number;
  /** End of the latest reading, or null before the first one arrives. */
  through: string | null;
  /** Half-hours before `through` with no reading. */
  missing: number;
  /** Half-hours read but not priced, so left out of `gbp`. */
  unpriced: number;
}

/** Energy cost with VAT for readings from `from`; standing charges are not included. */
export function spendSince(
  from: string,
  slots: readonly MeterSlot[],
  rates: readonly UsageRate[],
): Spend {
  const since = Date.parse(from);
  const spend: Spend = { gbp: 0, kwh: 0, through: null, missing: 0, unpriced: 0 };
  let read = 0;
  let latest = since;
  for (const slot of slots) {
    if (Date.parse(slot.start) < since) continue;
    read += 1;
    spend.kwh += slot.kwh;
    const cost = costForSlot(slot, rates);
    if (cost) spend.gbp += cost.gbp;
    else spend.unpriced += 1;
    latest = Math.max(latest, Date.parse(slot.through));
  }
  if (read === 0) return spend;
  spend.through = new Date(latest).toISOString();
  spend.missing = Math.max(Math.ceil((latest - since) / HALF_HOUR_MS) - read, 0);
  return spend;
}

export function rateAt<T extends RatePeriod>(
  rates: readonly T[],
  at: number,
): T | undefined {
  return rates.find((rate) => {
    const start = Date.parse(rate.start);
    return start <= at && at < start + HALF_HOUR_MS;
  });
}

export interface RateWindow {
  start: string;
  end: string;
  average: number;
}

/**
 * The lowest average price over `periods` consecutive half-hours, starting no
 * earlier than the half-hour containing `at`. Earliest wins a tie.
 */
export function cheapestWindow(
  rates: readonly RatePeriod[],
  at: number,
  periods: number,
): RateWindow | undefined {
  const ahead = rates
    .map((rate) => ({ start: Date.parse(rate.start), pIncVat: rate.pIncVat }))
    .filter((rate) => rate.start + HALF_HOUR_MS > at)
    .sort((a, b) => a.start - b.start);
  let best: { start: number; average: number } | undefined;
  for (let i = 0; i + periods <= ahead.length; i += 1) {
    const run = ahead.slice(i, i + periods);
    if (run.some((rate, k) => rate.start !== run[0]!.start + k * HALF_HOUR_MS)) continue;
    const average = run.reduce((sum, rate) => sum + rate.pIncVat, 0) / periods;
    if (!best || average < best.average) best = { start: run[0]!.start, average };
  }
  if (!best) return undefined;
  return {
    start: new Date(best.start).toISOString(),
    end: new Date(best.start + periods * HALF_HOUR_MS).toISOString(),
    average: best.average,
  };
}
