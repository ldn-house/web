import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumptionBetween,
  ratesBetween,
  recentAverageDemand,
  telemetryBetween,
} from './queries';

const AGILE = 'E-1R-AGILE-24-10-01-C';
const FLEXIBLE = 'E-1R-VAR-22-11-01-C';
const FAR_FUTURE = '2999-01-01T00:00:00Z';

async function seed(sql: string, ...binds: unknown[]) {
  await env.DB.prepare(sql)
    .bind(...(binds as never[]))
    .run();
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('queries', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM consumption'),
      env.DB.prepare('DELETE FROM unit_rates'),
      env.DB.prepare('DELETE FROM agreements'),
      env.DB.prepare('DELETE FROM telemetry'),
    ]);
  });

  it('returns readings inside a half-open window, oldest first', async () => {
    for (let i = 0; i < 100; i += 1) {
      const start = Date.parse('2026-01-01T00:00:00Z') + i * 1800_000;
      await seed(
        'INSERT INTO consumption (interval_start, interval_end, kwh, meter_serial) VALUES (?,?,?,?)',
        iso(start),
        iso(start + 1800_000),
        0.25,
        'SYNTH00000001',
      );
    }

    const slots = await consumptionBetween(
      '2026-01-01T12:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    expect(slots).toHaveLength(24);
    expect(slots[0]!.start).toBe('2026-01-01T12:00:00Z');
    expect(slots.at(-1)!.start).toBe('2026-01-01T23:30:00Z');
  });

  it('returns nothing rather than throwing when the table is empty', async () => {
    expect(
      await consumptionBetween('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
    ).toEqual([]);
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

    const rates = await ratesBetween(now, FAR_FUTURE);
    expect(rates).toHaveLength(1);
    expect(rates[0]!.pIncVat).toBe(22.5);
  });

  it('returns nothing when no agreement covers now', async () => {
    expect(await ratesBetween(new Date().toISOString(), FAR_FUTURE)).toEqual([]);
  });

  it('derives half-hourly kWh from register deltas and drops the bucket still filling', async () => {
    const t0 = Date.parse('2026-01-06T00:00:00Z');
    for (const [i, register] of [1000, 1250, 1600, 1700].entries()) {
      await seed(
        'INSERT INTO telemetry (read_at, demand_w, register_wh) VALUES (?,?,?)',
        iso(t0 + i * 1800_000),
        400,
        register,
      );
    }
    // "Now" is inside the last bucket, so it is excluded; the first row only anchors the deltas.
    const slots = await telemetryBetween(
      '2026-01-06T00:00:00Z',
      '2026-01-07T00:00:00Z',
      t0 + 3 * 1800_000 + 60_000,
    );
    expect(slots).toEqual([
      { start: '2026-01-06T00:30:00Z', kwh: 0.25 },
      { start: '2026-01-06T01:00:00Z', kwh: 0.35 },
    ]);
  });

  it('averages the recent demand only while the Home Mini is fresh', async () => {
    const readAt = '2026-01-06T00:00:00Z';
    for (const [minutes, watts] of [
      [0, 400],
      [30, 800],
    ] as const) {
      await seed(
        'INSERT INTO telemetry (read_at, demand_w, register_wh) VALUES (?,?,?)',
        iso(Date.parse(readAt) + minutes * 60_000),
        watts,
        1000,
      );
    }
    expect(await recentAverageDemand(Date.parse(readAt) + 40 * 60_000)).toEqual({
      through: '2026-01-06T00:30:00Z',
      watts: 600,
    });
    expect(await recentAverageDemand(Date.parse(readAt) + 90 * 60_000)).toBeNull();
  });

  it('returns no demand when there is no telemetry', async () => {
    expect(await recentAverageDemand()).toBeNull();
  });
});
