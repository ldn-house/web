import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { recentConsumption, upcomingRates } from './queries';

const AGILE = 'E-1R-AGILE-24-10-01-C';
const FLEXIBLE = 'E-1R-VAR-22-11-01-C';

async function seed(sql: string, ...binds: unknown[]) {
  await env.DB.prepare(sql)
    .bind(...(binds as never[]))
    .run();
}

describe('queries', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM consumption'),
      env.DB.prepare('DELETE FROM unit_rates'),
      env.DB.prepare('DELETE FROM agreements'),
    ]);
  });

  it('windows back from the newest reading, not from wall-clock now', async () => {
    // Readings are historical: anchoring on Date.now() would return nothing.
    for (let i = 0; i < 100; i += 1) {
      const start = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1800_000);
      const end = new Date(start.getTime() + 1800_000);
      await seed(
        'INSERT INTO consumption (interval_start, interval_end, kwh, meter_serial) VALUES (?,?,?,?)',
        start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        0.25,
        'SYNTH00000001',
      );
    }

    const slots = await recentConsumption(24);
    expect(slots).toHaveLength(48);
    // Newest reading ends 2026-01-03T02:00Z, so the window opens 24h before.
    expect(slots[0]!.start).toBe('2026-01-02T02:00:00Z');
    expect(slots.at(-1)!.start).toBe('2026-01-03T01:30:00Z');
  });

  it('returns nothing rather than throwing when the table is empty', async () => {
    expect(await recentConsumption(24)).toEqual([]);
  });

  it('prices against the tariff in force, ignoring a lapsed agreement', async () => {
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 86_400_000 * 30).toISOString();
    await seed(
      'INSERT INTO agreements (tariff_code, valid_from, valid_to) VALUES (?,?,?)',
      FLEXIBLE,
      '2025-10-11T00:00:00Z',
      past,
    );
    await seed(
      'INSERT INTO agreements (tariff_code, valid_from, valid_to) VALUES (?,?,NULL)',
      AGILE,
      past,
    );

    for (const [tariff, price] of [
      [AGILE, 22.5],
      [FLEXIBLE, 26.3],
    ] as const) {
      await seed(
        'INSERT INTO unit_rates (tariff_code, valid_from, payment_method, valid_to, p_inc_vat, p_exc_vat) VALUES (?,?,?,NULL,?,?)',
        tariff,
        now,
        'ANY',
        price,
        price / 1.05,
      );
    }

    const rates = await upcomingRates(now);
    expect(rates).toHaveLength(1);
    expect(rates[0]!.pIncVat).toBe(22.5);
  });

  it('returns nothing when no agreement covers now', async () => {
    expect(await upcomingRates(new Date().toISOString())).toEqual([]);
  });
});
