import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingest } from './ingest';
import type { Fetcher } from './octopus';

// Synthetic throughout — never a real MPAN, serial or account number.
const MPAN = '1234567890123';
const SERIAL = 'SYNTH00000001';
const TARIFF = 'E-1R-AGILE-24-10-01-C';

interface FakeApi {
  /** Half-hourly readings the fake meter will report, in UTC. */
  readings: { interval_start: string; interval_end: string; consumption: number }[];
  rates: {
    valid_from: string;
    valid_to: string | null;
    value_inc_vat: number;
    value_exc_vat: number;
  }[];
}

/** Records the period_from each endpoint was asked for, to assert incrementality. */
function fakeOctopus(api: FakeApi) {
  const asked: Record<string, string[]> = { consumption: [], rates: [] };

  const fetchImpl = (async (input: string | URL | Request) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = new URL(raw);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/v1/graphql/') {
      // First call obtains the token, second lists accounts.
      return json(
        asked.graphql?.length
          ? { data: { viewer: { accounts: [{ number: 'A-SYNTH01' }] } } }
          : ((asked.graphql = ['t']),
            { data: { obtainKrakenToken: { token: 'synthetic-token' } } }),
      );
    }

    if (url.pathname.startsWith('/v1/accounts/')) {
      return json({
        properties: [
          {
            electricity_meter_points: [
              {
                mpan: MPAN,
                is_export: false,
                meters: [{ serial_number: SERIAL }],
                agreements: [
                  {
                    tariff_code: TARIFF,
                    valid_from: '2025-12-24T00:00:00Z',
                    valid_to: null,
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    const from = url.searchParams.get('period_from') ?? '';

    if (url.pathname.includes('/consumption/')) {
      asked.consumption!.push(from);
      const results = api.readings.filter((r) => r.interval_start >= from);
      return json({ count: results.length, next: null, results });
    }

    if (url.pathname.includes('/standard-unit-rates/')) {
      asked.rates!.push(from);
      const results = api.rates.filter((r) => r.valid_from >= from);
      return json({ count: results.length, next: null, results });
    }

    // standing-charges
    return json({ count: 0, next: null, results: [] });
  }) as unknown as Fetcher;

  return { fetchImpl, asked };
}

function halfHours(startIso: string, count: number) {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => {
    const from = new Date(start + i * 30 * 60_000);
    const to = new Date(start + (i + 1) * 30 * 60_000);
    return {
      interval_start: from.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      interval_end: to.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      consumption: 0.25,
    };
  });
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe('ingest against D1', () => {
  let api: FakeApi;

  beforeEach(async () => {
    // The pool isolates storage per test file, not per test, so each case
    // resets the tables it asserts on.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM consumption'),
      env.DB.prepare('DELETE FROM unit_rates'),
      env.DB.prepare('DELETE FROM standing_charges'),
      env.DB.prepare('DELETE FROM agreements'),
    ]);

    api = {
      readings: halfHours('2026-01-01T00:00:00Z', 240),
      rates: halfHours('2026-01-01T00:00:00Z', 240).map((r) => ({
        valid_from: r.interval_start,
        valid_to: r.interval_end,
        value_inc_vat: 20,
        value_exc_vat: 19.05,
      })),
    };
  });

  it('backfills an empty database in chunks that respect D1 bound-parameter limits', async () => {
    // 240 rows x 4 columns is well past the 100-parameter ceiling, so this only
    // passes if the insert is actually chunked.
    const { fetchImpl } = fakeOctopus(api);
    const summary = await ingest(env, { fetchImpl });

    expect(summary.consumptionRows).toBe(240);
    expect(await count('consumption')).toBe(240);
    expect(await count('unit_rates')).toBe(240);
    expect(await count('agreements')).toBe(1);
  });

  it('is idempotent when the same window is ingested twice', async () => {
    const first = fakeOctopus(api);
    await ingest(env, { fetchImpl: first.fetchImpl, since: '2020-01-01T00:00:00Z' });
    const second = fakeOctopus(api);
    await ingest(env, { fetchImpl: second.fetchImpl, since: '2020-01-01T00:00:00Z' });

    expect(await count('consumption')).toBe(240);
    expect(await count('unit_rates')).toBe(240);
  });

  it('resumes from the stored watermark rather than refetching everything', async () => {
    const first = fakeOctopus(api);
    await ingest(env, { fetchImpl: first.fetchImpl });
    expect(first.asked.consumption![0]).toBe('2020-01-01T00:00:00Z');

    api.readings.push(...halfHours('2026-01-06T00:00:00Z', 10));
    const second = fakeOctopus(api);
    const summary = await ingest(env, { fetchImpl: second.fetchImpl });

    // Resumes at the last stored interval_end, so only the new slots come back.
    expect(second.asked.consumption![0]).toBe('2026-01-06T00:00:00Z');
    expect(summary.consumptionRows).toBe(10);
    expect(await count('consumption')).toBe(250);
  });

  it('tracks watermarks per table so rates are not skipped by consumption progress', async () => {
    // Consumption runs ahead of rates: a shared watermark would resume the rate
    // fetch at the later consumption timestamp and lose the gap in between.
    api.readings = halfHours('2026-01-10T00:00:00Z', 10);
    api.rates = [];
    const first = fakeOctopus(api);
    await ingest(env, { fetchImpl: first.fetchImpl });
    expect(await count('unit_rates')).toBe(0);

    api.rates = halfHours('2026-01-01T00:00:00Z', 48).map((r) => ({
      valid_from: r.interval_start,
      valid_to: r.interval_end,
      value_inc_vat: 20,
      value_exc_vat: 19.05,
    }));
    const second = fakeOctopus(api);
    await ingest(env, { fetchImpl: second.fetchImpl });

    // Rates still resume from the floor, not from the consumption watermark.
    expect(second.asked.rates![0]).toBe('2020-01-01T00:00:00Z');
    expect(await count('unit_rates')).toBe(48);
  });

  it('normalises BST readings to UTC before storing them', async () => {
    api.readings = [
      {
        interval_start: '2026-07-15T01:00:00+01:00',
        interval_end: '2026-07-15T01:30:00+01:00',
        consumption: 0.4,
      },
    ];
    const { fetchImpl } = fakeOctopus(api);
    await ingest(env, { fetchImpl });

    const row = await env.DB.prepare('SELECT interval_start FROM consumption').first<{
      interval_start: string;
    }>();
    // Same instant as the rate slot published as 00:00:00Z, so joins line up.
    expect(row?.interval_start).toBe('2026-07-15T00:00:00Z');
  });
});
