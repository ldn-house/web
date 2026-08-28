import type { Fetcher } from './octopus';

/** Octopus-shaped responses captured from the live API, with identifiers scrubbed. */
export interface OctopusFixture {
  accountNumber: string;
  mpan: string;
  meterSerial: string;
  agreements: { tariff_code: string; valid_from: string; valid_to: string | null }[];
  consumption: { interval_start: string; interval_end: string; consumption: number }[];
  unitRates: Record<string, unknown[]>;
  standingCharges: Record<string, unknown[]>;
}

/**
 * Serves a fixture over the same request shapes the live API uses, so seeding
 * runs the real ingest — parsing, pagination, upserts and all — rather than a
 * parallel code path that could drift from it.
 */
export function replayFetcher(fixture: OctopusFixture): Fetcher {
  let tokenIssued = false;

  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/v1/graphql/') {
      if (!tokenIssued) {
        tokenIssued = true;
        return json({ data: { obtainKrakenToken: { token: 'replay' } } });
      }
      return json({
        data: { viewer: { accounts: [{ number: fixture.accountNumber }] } },
      });
    }

    if (url.pathname.startsWith('/v1/accounts/')) {
      return json({
        properties: [
          {
            electricity_meter_points: [
              {
                mpan: fixture.mpan,
                is_export: false,
                meters: [{ serial_number: fixture.meterSerial }],
                agreements: fixture.agreements,
              },
            ],
          },
        ],
      });
    }

    const from = url.searchParams.get('period_from') ?? '';
    const tariff = /electricity-tariffs\/([^/]+)\//.exec(url.pathname)?.[1] ?? '';

    const page = (rows: { valid_from?: string; interval_start?: string }[]) =>
      json({
        count: rows.length,
        next: null,
        results: rows.filter((r) => (r.valid_from ?? r.interval_start ?? '') >= from),
      });

    if (url.pathname.includes('/consumption/')) return page(fixture.consumption);
    if (url.pathname.includes('/standard-unit-rates/')) {
      return page((fixture.unitRates[tariff] ?? []) as { valid_from: string }[]);
    }
    return page((fixture.standingCharges[tariff] ?? []) as { valid_from: string }[]);
  }) as unknown as Fetcher;
}
