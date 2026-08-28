import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingest } from './ingest';
import type { Fetcher } from './octopus';

// Synthetic throughout — never a real MPAN, serial or account number.
const MPAN = '1234567890123';
const SERIAL = 'SYNTH00000001';
const TARIFF = 'E-1R-AGILE-24-10-01-C';

interface Rate {
  valid_from: string;
  valid_to: string | null;
  value_inc_vat: number;
  value_exc_vat: number;
  payment_method: string | null;
}

interface FakeApi {
  readings: { interval_start: string; interval_end: string; consumption: number }[];
  rates: Rate[];
  standing: Rate[];
}

function fakeOctopus(api: FakeApi) {
  const asked: Record<string, string[]> = { consumption: [], rates: [], standing: [] };
  let tokenIssued = false;

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/v1/graphql/') {
      if (!tokenIssued) {
        tokenIssued = true;
        return json({ data: { obtainKrakenToken: { token: 'synthetic-token' } } });
      }
      return json({ data: { viewer: { accounts: [{ number: 'A-SYNTH01' }] } } });
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
    const page = (
      key: string,
      rows: { valid_from?: string; interval_start?: string }[],
    ) => {
      asked[key]!.push(from);
      const results = rows.filter(
        (r) => (r.valid_from ?? r.interval_start ?? '') >= from,
      );
      return json({ count: results.length, next: null, results });
    };

    if (url.pathname.includes('/consumption/')) return page('consumption', api.readings);
    if (url.pathname.includes('/standard-unit-rates/')) return page('rates', api.rates);
    return page('standing', api.standing);
  }) as unknown as Fetcher;

  return { fetchImpl, asked };
}

function halfHours(startIso: string, count: number) {
  const start = Date.parse(startIso);
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return Array.from({ length: count }, (_, i) => ({
    interval_start: iso(start + i * 30 * 60_000),
    interval_end: iso(start + (i + 1) * 30 * 60_000),
    consumption: 0.25,
  }));
}

function rates(
  startIso: string,
  count: number,
  paymentMethod: string | null = null,
): Rate[] {
  return halfHours(startIso, count).map((r) => ({
    valid_from: r.interval_start,
    valid_to: r.interval_end,
    value_inc_vat: 20,
    value_exc_vat: 19.05,
    payment_method: paymentMethod,
  }));
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
    // The pool isolates storage per test file, not per test.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM consumption'),
      env.DB.prepare('DELETE FROM unit_rates'),
      env.DB.prepare('DELETE FROM standing_charges'),
      env.DB.prepare('DELETE FROM agreements'),
    ]);

    api = {
      readings: halfHours('2026-01-01T00:00:00Z', 240),
      rates: rates('2026-01-01T00:00:00Z', 240),
      standing: [],
    };
  });

  it('backfills in chunks that respect D1 bound-parameter limits', async () => {
    // 240 rows well past the 100-parameter ceiling; only passes if chunked.
    const { fetchImpl } = fakeOctopus(api);
    const summary = await ingest(env, { fetchImpl });

    expect(summary.consumptionRows).toBe(240);
    expect(await count('consumption')).toBe(240);
    expect(await count('unit_rates')).toBe(240);
    expect(await count('agreements')).toBe(1);
  });

  it('is idempotent when the same window is ingested twice', async () => {
    for (let run = 0; run < 2; run += 1) {
      const { fetchImpl } = fakeOctopus(api);
      await ingest(env, { fetchImpl, since: '2020-01-01T00:00:00Z' });
    }
    expect(await count('consumption')).toBe(240);
    expect(await count('unit_rates')).toBe(240);
  });

  it('keeps payment-method variants apart rather than collapsing them', async () => {
    // Variable tariffs publish both at the same valid_from and different prices.
    api.rates = [
      ...rates('2026-01-01T00:00:00Z', 1, 'DIRECT_DEBIT').map((r) => ({
        ...r,
        value_inc_vat: 26.3,
      })),
      ...rates('2026-01-01T00:00:00Z', 1, 'NON_DIRECT_DEBIT').map((r) => ({
        ...r,
        value_inc_vat: 27.8,
      })),
    ];
    const { fetchImpl } = fakeOctopus(api);
    await ingest(env, { fetchImpl });

    const stored = await env.DB.prepare(
      'SELECT payment_method, p_inc_vat FROM unit_rates ORDER BY payment_method',
    ).all<{ payment_method: string; p_inc_vat: number }>();
    expect(stored.results).toEqual([
      { payment_method: 'DIRECT_DEBIT', p_inc_vat: 26.3 },
      { payment_method: 'NON_DIRECT_DEBIT', p_inc_vat: 27.8 },
    ]);
  });

  it('closes an open-ended period once the API fills in valid_to', async () => {
    api.rates = [
      {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        value_inc_vat: 20,
        value_exc_vat: 19.05,
        payment_method: null,
      },
    ];
    await ingest(env, { fetchImpl: fakeOctopus(api).fetchImpl });

    // The period ends and is repriced; ignoring the conflict would pin the null.
    api.rates[0]!.valid_to = '2026-04-01T00:00:00Z';
    api.rates[0]!.value_inc_vat = 24.5;
    await ingest(env, {
      fetchImpl: fakeOctopus(api).fetchImpl,
      since: '2020-01-01T00:00:00Z',
    });

    const row = await env.DB.prepare('SELECT valid_to, p_inc_vat FROM unit_rates').first<{
      valid_to: string | null;
      p_inc_vat: number;
    }>();
    expect(row).toEqual({ valid_to: '2026-04-01T00:00:00Z', p_inc_vat: 24.5 });
  });

  it('re-reads behind the watermark so late or corrected readings are not missed', async () => {
    await ingest(env, { fetchImpl: fakeOctopus(api).fetchImpl });

    const second = fakeOctopus(api);
    await ingest(env, { fetchImpl: second.fetchImpl });

    // Last stored interval_end is 2026-01-06T00:00Z; the window opens a week earlier.
    expect(second.asked.consumption![0]).toBe('2025-12-30T00:00:00Z');
  });

  it('replaces a reading the API later corrects', async () => {
    await ingest(env, { fetchImpl: fakeOctopus(api).fetchImpl });
    api.readings[0]!.consumption = 9.9;
    await ingest(env, { fetchImpl: fakeOctopus(api).fetchImpl });

    const row = await env.DB.prepare(
      'SELECT kwh FROM consumption ORDER BY interval_start LIMIT 1',
    ).first<{ kwh: number }>();
    expect(row?.kwh).toBe(9.9);
    expect(await count('consumption')).toBe(240);
  });

  it('tracks standing charges on their own watermark, not the unit-rate one', async () => {
    // Unit rates land, standing charges do not. A shared watermark would resume
    // standing charges past the history they never got.
    await ingest(env, { fetchImpl: fakeOctopus(api).fetchImpl });
    expect(await count('standing_charges')).toBe(0);

    api.standing = rates('2026-01-01T00:00:00Z', 4);
    const second = fakeOctopus(api);
    await ingest(env, { fetchImpl: second.fetchImpl });

    expect(second.asked.standing![0]).toBe('2020-01-01T00:00:00Z');
    expect(await count('standing_charges')).toBe(4);
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

describe('rate ordering', () => {
  it('writes rates oldest-first so a truncated run resumes forward', async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM unit_rates'),
      env.DB.prepare('DELETE FROM consumption'),
    ]);

    // Octopus serves newest-first; a partial write in that order would strand
    // the watermark at the newest slot and skip everything older forever.
    const api: FakeApi = {
      readings: [],
      rates: rates('2026-01-01T00:00:00Z', 6).reverse(),
      standing: [],
    };
    await ingest(env, { fetchImpl: fakeOctopus(api).fetchImpl });

    const written = await env.DB.prepare(
      'SELECT valid_from FROM unit_rates ORDER BY rowid',
    ).all<{ valid_from: string }>();
    const order = written.results.map((r) => r.valid_from);
    expect(order).toEqual([...order].sort());
  });
});
