import { addLondonDays, londonMidnight } from './format';

export type Scale = (value: number) => number;

/** Yesterday and today, extended through tomorrow when tomorrow has rates. */
export function recentDayBounds(
  now: string,
  rateStarts: readonly string[] = [],
): readonly [from: string, to: string] {
  const today = londonMidnight(now);
  const tomorrow = addLondonDays(today, 1);
  const dayAfterTomorrow = addLondonDays(today, 2);
  const hasTomorrowRates = rateStarts.some((start) => {
    const timestamp = Date.parse(start);
    return timestamp >= Date.parse(tomorrow) && timestamp < Date.parse(dayAfterTomorrow);
  });

  return [addLondonDays(today, -1), hasTomorrowRates ? dayAfterTomorrow : tomorrow];
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => r0;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / magnitude) * magnitude;
}

export function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max / count) * i);
}

export function tickIndices(length: number, count = 6): number[] {
  if (length === 0) return [];
  const step = Math.max(Math.floor(length / count), 1);
  const out: number[] = [];
  for (let i = 0; i < length; i += step) out.push(i);
  return out;
}

export function stepPath(
  points: readonly { x: number; y: number }[],
  endX: number,
): string {
  if (points.length === 0) return '';
  const parts = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let i = 1; i < points.length; i += 1) {
    parts.push(
      `L ${points[i]!.x} ${points[i - 1]!.y}`,
      `L ${points[i]!.x} ${points[i]!.y}`,
    );
  }
  parts.push(`L ${endX} ${points.at(-1)!.y}`);
  return parts.join(' ');
}
