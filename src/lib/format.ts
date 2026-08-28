const LONDON = 'Europe/London';

export function londonTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function londonDay(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

export interface AxisTick {
  index: number;
  time: string;
  /** Null unless the day changed, so a multi-day axis is not repetitive. */
  day: string | null;
}

export function axisTicks(
  starts: readonly string[],
  indices: readonly number[],
): AxisTick[] {
  let previous = '';
  return indices.map((index) => {
    const iso = starts[index]!;
    const day = londonDay(iso);
    const changed = day !== previous;
    previous = day;
    return { index, time: londonTime(iso), day: changed ? day : null };
  });
}
