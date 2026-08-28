import type { Slot } from '../components/UsageChart';

/**
 * Synthetic half-hourly profile standing in for the Octopus feed until ingest
 * lands: an overnight base load with a morning bump and an evening peak.
 */
export function sampleDay(day = new Date('2026-08-27T00:00:00Z')): Slot[] {
  const shape = (hour: number) => {
    const base = 0.28;
    const morning = 0.34 * Math.exp(-(((hour - 7.5) / 1.6) ** 2));
    const evening = 0.52 * Math.exp(-(((hour - 19.5) / 2.2) ** 2));
    return base + morning + evening;
  };

  return Array.from({ length: 48 }, (_, index) => {
    const hour = index / 2;
    // Deterministic jitter so the server render is stable across requests.
    const jitter = 0.04 * Math.sin(index * 2.399);
    return {
      start: new Date(day.getTime() + index * 30 * 60 * 1000),
      kwh: Math.max(shape(hour) + jitter, 0.05),
    };
  });
}
