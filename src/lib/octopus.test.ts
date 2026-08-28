import { describe, expect, it } from 'bun:test';
import {
  discoverAccountNumber,
  type Fetcher,
  fetchAccount,
  fetchConsumption,
  fetchUnitRates,
  OctopusError,
  productCodeFromTariff,
} from './octopus';

// Synthetic identifiers throughout — never a real MPAN or meter serial.
const MPAN = '1234567890123';
const SERIAL = 'SYNTH00000001';
const KEY = 'sk_test_synthetic';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Records every requested URL so tests can assert on query construction. */
function stubFetch(handler: (url: string) => unknown): {
  fetch: Fetcher;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    return jsonResponse(handler(url));
  }) as Fetcher;
  return { fetch: fetchImpl, urls };
}

describe('productCodeFromTariff', () => {
  it('strips the fuel/register prefix and the region letter', () => {
    expect(productCodeFromTariff('E-1R-AGILE-24-10-01-C')).toBe('AGILE-24-10-01');
    expect(productCodeFromTariff('E-1R-VAR-22-11-01-C')).toBe('VAR-22-11-01');
  });

  it('handles multi-register codes', () => {
    expect(productCodeFromTariff('E-2R-ECO7-20-01-01-A')).toBe('ECO7-20-01-01');
  });

  it('rejects anything that is not a tariff code', () => {
    expect(() => productCodeFromTariff('AGILE-24-10-01')).toThrow(OctopusError);
  });
});

describe('discoverAccountNumber', () => {
  const account = { number: 'A-SYNTH01' };

  it('exchanges the key for a token and returns the single account', async () => {
    const { fetch, urls } = stubFetch((url) => {
      expect(url).toContain('/graphql/');
      return urls.length === 1
        ? { data: { obtainKrakenToken: { token: 'synthetic-token' } } }
        : { data: { viewer: { accounts: [account] } } };
    });
    expect(await discoverAccountNumber(KEY, fetch)).toBe('A-SYNTH01');
  });

  it('fails loudly when the key yields no token', async () => {
    const { fetch } = stubFetch(() => ({ data: { obtainKrakenToken: null } }));
    expect(discoverAccountNumber(KEY, fetch)).rejects.toThrow('Kraken token');
  });

  it('refuses to guess when the key covers several accounts', async () => {
    const { fetch, urls } = stubFetch(() =>
      urls.length === 1
        ? { data: { obtainKrakenToken: { token: 't' } } }
        : { data: { viewer: { accounts: [account, { number: 'A-SYNTH02' }] } } },
    );
    expect(discoverAccountNumber(KEY, fetch)).rejects.toThrow('found 2');
  });
});

describe('fetchAccount', () => {
  it('flattens properties and drops export meter points', async () => {
    const { fetch } = stubFetch(() => ({
      properties: [
        {
          electricity_meter_points: [
            {
              mpan: MPAN,
              is_export: false,
              meters: [{ serial_number: SERIAL }],
              agreements: [],
            },
            { mpan: '9999999999999', is_export: true, meters: [], agreements: [] },
          ],
        },
        {},
      ],
    }));

    const account = await fetchAccount(KEY, 'A-SYNTH01', fetch);
    expect(account.meterPoints).toHaveLength(1);
    expect(account.meterPoints[0]!.mpan).toBe(MPAN);
  });

  it('surfaces the status on failure', async () => {
    const failing = (async () =>
      jsonResponse({ detail: 'nope' }, 403)) as unknown as Fetcher;
    expect(fetchAccount(KEY, 'A-SYNTH01', failing)).rejects.toThrow(OctopusError);
  });
});

describe('fetchConsumption', () => {
  it('always sends period_from, without which Octopus truncates the history', async () => {
    const { fetch, urls } = stubFetch(() => ({ count: 0, next: null, results: [] }));
    await fetchConsumption(KEY, MPAN, SERIAL, '2025-12-01T00:00:00Z', fetch);
    expect(urls[0]).toContain('period_from=2025-12-01T00%3A00%3A00Z');
    expect(urls[0]).toContain(
      `/electricity-meter-points/${MPAN}/meters/${SERIAL}/consumption/`,
    );
  });

  it('follows the next chain and concatenates pages', async () => {
    const reading = (start: string) => ({
      consumption: 0.25,
      interval_start: start,
      interval_end: start,
    });
    const { fetch, urls } = stubFetch((url) =>
      url.includes('page=2')
        ? { count: 2, next: null, results: [reading('b')] }
        : {
            count: 2,
            next: 'https://api.octopus.energy/v1/x/?page=2',
            results: [reading('a')],
          },
    );

    const readings = await fetchConsumption(
      KEY,
      MPAN,
      SERIAL,
      '2025-12-01T00:00:00Z',
      fetch,
    );
    expect(readings.map((r) => r.interval_start)).toEqual(['a', 'b']);
    expect(urls).toHaveLength(2);
  });
});

describe('fetchUnitRates', () => {
  it('derives the product code from the tariff code', async () => {
    const { fetch, urls } = stubFetch(() => ({ count: 0, next: null, results: [] }));
    await fetchUnitRates(KEY, 'E-1R-AGILE-24-10-01-C', '2025-12-01T00:00:00Z', fetch);
    expect(urls[0]).toContain(
      '/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/',
    );
  });
});
