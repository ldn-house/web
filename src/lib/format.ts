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

function londonOffsetMs(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
  );
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/** Start of the London calendar day containing `iso`, as a UTC instant. */
export function londonMidnight(iso: string): string {
  const ms = Date.parse(iso);
  const local = ms + londonOffsetMs(ms);
  const guess = local - (local % 86_400_000) - londonOffsetMs(ms);
  // The offset at the guess can differ from the offset at `ms` across a DST change.
  const corrected = guess + (londonOffsetMs(ms) - londonOffsetMs(guess));
  return new Date(corrected).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addLondonDays(midnightIso: string, days: number): string {
  return londonMidnight(
    new Date(Date.parse(midnightIso) + days * 86_400_000 + 43_200_000).toISOString(),
  );
}

export interface TimeTick {
  iso: string;
  label: string;
  major: boolean;
}

/** Midnight (labelled with the day) and noon ticks across a window. */
export function dayTicks(fromIso: string, toIso: string): TimeTick[] {
  const ticks: TimeTick[] = [];
  const end = Date.parse(toIso);
  for (
    let day = londonMidnight(fromIso);
    Date.parse(day) < end;
    day = addLondonDays(day, 1)
  ) {
    if (Date.parse(day) >= Date.parse(fromIso))
      ticks.push({ iso: day, label: londonDay(day), major: true });
    const noon = new Date(Date.parse(day) + 12 * 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    if (Date.parse(noon) < end) ticks.push({ iso: noon, label: '12:00', major: false });
  }
  return ticks;
}
