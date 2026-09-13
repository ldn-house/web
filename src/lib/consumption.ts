export const HALF_HOUR_MS = 30 * 60_000;

export interface Slot {
  /** Start of the settlement period, in UTC. */
  start: string;
  kwh: number;
}

export interface MeterSlot extends Slot {
  /** End of the available data; may be inside the settlement period. */
  through: string;
}

export interface UsageSlot extends MeterSlot {
  source: 'billing' | 'meter';
}

/** The API's consumptionDelta belongs to readAt, unlike adjacent register differences. */
export function meterSlots(
  readings: readonly { readAt: string; consumptionDelta?: string | null }[],
  through: string,
): MeterSlot[] {
  const end = Date.parse(through);
  if (!Number.isFinite(end)) return [];
  return readings.flatMap((reading) => {
    const start = Date.parse(reading.readAt);
    const wh =
      reading.consumptionDelta == null || reading.consumptionDelta.trim() === ''
        ? Number.NaN
        : Number(reading.consumptionDelta);
    if (
      !Number.isFinite(start) ||
      start % HALF_HOUR_MS !== 0 ||
      start >= end ||
      !Number.isFinite(wh) ||
      wh < 0
    )
      return [];
    return [
      {
        start: new Date(start).toISOString(),
        kwh: wh / 1000,
        through: new Date(Math.min(start + HALF_HOUR_MS, end)).toISOString(),
      },
    ];
  });
}

/** Each period appears once; billing takes precedence as it arrives. */
export function mergeConsumption(
  billed: readonly Slot[],
  stored: readonly MeterSlot[],
  recent: readonly MeterSlot[],
  from: string,
  to: string,
): UsageSlot[] {
  const slots = new Map<number, UsageSlot>();
  for (const slot of [...stored, ...recent]) {
    const start = Date.parse(slot.start);
    const previous = slots.get(start);
    if (!previous || Date.parse(slot.through) >= Date.parse(previous.through)) {
      slots.set(start, {
        ...slot,
        start: new Date(start).toISOString(),
        source: 'meter',
      });
    }
  }
  for (const slot of billed) {
    const start = Date.parse(slot.start);
    slots.set(start, {
      ...slot,
      start: new Date(start).toISOString(),
      source: 'billing',
      through: new Date(start + HALF_HOUR_MS).toISOString(),
    });
  }
  return [...slots.entries()]
    .filter(([start]) => start >= Date.parse(from) && start < Date.parse(to))
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => slot);
}

export function isPartialSlot(slot: MeterSlot): boolean {
  return Date.parse(slot.through) < Date.parse(slot.start) + HALF_HOUR_MS;
}

export function isMeterSlot(value: unknown): value is MeterSlot {
  if (!value || typeof value !== 'object') return false;
  const slot = value as Partial<MeterSlot>;
  if (
    typeof slot.start !== 'string' ||
    typeof slot.through !== 'string' ||
    typeof slot.kwh !== 'number' ||
    !Number.isFinite(slot.kwh) ||
    slot.kwh < 0
  )
    return false;
  const start = Date.parse(slot.start);
  const through = Date.parse(slot.through);
  return (
    Number.isFinite(start) &&
    start % HALF_HOUR_MS === 0 &&
    through > start &&
    through <= start + HALF_HOUR_MS
  );
}
