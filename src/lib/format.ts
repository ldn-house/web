const LONDON = 'Europe/London';

/** Timestamps are stored in UTC but a house is read in local time. */
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
