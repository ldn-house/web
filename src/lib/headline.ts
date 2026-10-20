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

/**
 * Energy cost with VAT for readings from `from`, and before `until` if given;
 * standing charges are not included. With `until`, a period missing anywhere
 * in the range counts, not just one before the latest reading.
 */
export function spendSince(
  from: string,
  slots: readonly MeterSlot[],
  rates: readonly UsageRate[],
  until?: string,
): Spend {
  const since = Date.parse(from);
  const end = until === undefined ? Infinity : Date.parse(until);
  const spend: Spend = { gbp: 0, kwh: 0, through: null, missing: 0, unpriced: 0 };
  let read = 0;
  let latest = since;
  for (const slot of slots) {
    const start = Date.parse(slot.start);
    if (start < since || start >= end) continue;
    read += 1;
    spend.kwh += slot.kwh;
    const cost = costForSlot(slot, rates);
    if (cost) spend.gbp += cost.gbp;
    else spend.unpriced += 1;
    latest = Math.max(latest, Date.parse(slot.through));
  }
  if (read === 0) return spend;
  spend.through = new Date(latest).toISOString();
  const span = (until === undefined ? latest : end) - since;
  spend.missing = Math.max(Math.ceil(span / HALF_HOUR_MS) - read, 0);
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
 * The lowest time-weighted average price over `periods` half-hours, starting
 * either at `at` or on a later half-hour boundary. Every minute of a window
 * needs a published rate. Earliest wins a tie.
 */
export function cheapestWindow(
  rates: readonly RatePeriod[],
  at: number,
  periods: number,
): RateWindow | undefined {
  const prices = new Map(rates.map((rate) => [Date.parse(rate.start), rate.pIncVat]));
  const duration = periods * HALF_HOUR_MS;
  const later = [...prices.keys()].filter((start) => start > at).sort((a, b) => a - b);
  let best: { start: number; average: number } | undefined;
  for (const start of [at, ...later]) {
    let pence = 0;
    let covered = true;
    for (let t = start; t < start + duration; ) {
      const period = Math.floor(t / HALF_HOUR_MS) * HALF_HOUR_MS;
      const price = prices.get(period);
      if (price === undefined) {
        covered = false;
        break;
      }
      const until = Math.min(period + HALF_HOUR_MS, start + duration);
      pence += price * (until - t);
      t = until;
    }
    if (!covered) continue;
    const average = pence / duration;
    // Below the precision Octopus publishes, so equal prices stay a tie.
    if (!best || average < best.average - 1e-9) best = { start, average };
  }
  if (!best) return undefined;
  return {
    start: new Date(best.start).toISOString(),
    end: new Date(best.start + duration).toISOString(),
    average: best.average,
  };
}
