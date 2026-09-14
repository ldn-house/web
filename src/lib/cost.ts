import { HALF_HOUR_MS, type Slot } from './consumption';

/** A unit rate clipped to the dates of the customer's tariff agreement. */
export interface UsageRate {
  from: string;
  to: string;
  pIncVat: number;
}

/** Energy cost only, with VAT. Keep full precision until display or summation. */
export function costForSlot(slot: Slot, rates: readonly UsageRate[]) {
  const start = Date.parse(slot.start);
  const end = start + HALF_HOUR_MS;
  // Even a partial reading uses the rate for its whole settlement period. If
  // the price changes within it, we cannot split an aggregate kWh reading.
  const prices = new Set(
    rates
      .filter((rate) => Date.parse(rate.from) <= start && Date.parse(rate.to) >= end)
      .map((rate) => rate.pIncVat),
  );
  const [pIncVat] = prices;
  if (
    prices.size !== 1 ||
    pIncVat === undefined ||
    !Number.isFinite(pIncVat) ||
    !Number.isFinite(slot.kwh) ||
    slot.kwh < 0
  )
    return null;
  return { gbp: (slot.kwh * pIncVat) / 100, pIncVat };
}
