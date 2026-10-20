const londonDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  month: 'numeric',
  day: 'numeric',
});

/** 1 December to 6 January inclusive, by the London calendar. */
export function inTreeSeason(at: number): boolean {
  const parts = londonDate.formatToParts(at);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  return month === 12 || (month === 1 && day <= 6);
}
