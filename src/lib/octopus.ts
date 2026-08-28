/**
 * REST serves consumption and tariff data (Basic auth, API key as username).
 * Account discovery is GraphQL-only — `GET /v1/accounts/` returns 403.
 */

const REST = 'https://api.octopus.energy/v1';
const GRAPHQL = 'https://api.octopus.energy/v1/graphql/';

/** Guards against a malformed `next` chain spinning forever. */
const MAX_PAGES = 100;

export type Fetcher = typeof fetch;

export interface ConsumptionReading {
  consumption: number;
  interval_start: string;
  interval_end: string;
}

export interface RatePeriod {
  value_exc_vat: number;
  value_inc_vat: number;
  valid_from: string;
  valid_to: string | null;
  /** Null on tariffs that do not price by payment method, such as Agile. */
  payment_method: string | null;
}

export interface Agreement {
  tariff_code: string;
  valid_from: string;
  valid_to: string | null;
}

export interface MeterPoint {
  mpan: string;
  is_export: boolean;
  meters: { serial_number: string }[];
  agreements: Agreement[];
}

export interface Account {
  number: string;
  meterPoints: MeterPoint[];
}

export class OctopusError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OctopusError';
  }
}

function authHeader(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

async function getJson<T>(url: string, apiKey: string, fetchImpl: Fetcher): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!response.ok) {
    throw new OctopusError(`GET ${new URL(url).pathname} failed`, response.status);
  }
  return (await response.json()) as T;
}

interface Page<T> {
  count: number;
  next: string | null;
  results: T[];
}

async function getAllPages<T>(
  first: string,
  apiKey: string,
  fetchImpl: Fetcher,
): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = first;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const body: Page<T> = await getJson<Page<T>>(url, apiKey, fetchImpl);
    all.push(...body.results);
    url = body.next;
  }
  return all;
}

/** Throws on multiple accounts rather than silently ingesting the wrong meter. */
export async function discoverAccountNumber(
  apiKey: string,
  fetchImpl: Fetcher = fetch,
): Promise<string> {
  const tokenResponse = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($a: String!){ obtainKrakenToken(input:{APIKey:$a}){ token } }',
      variables: { a: apiKey },
    }),
  });
  const tokenBody = (await tokenResponse.json()) as {
    data?: { obtainKrakenToken?: { token?: string } | null };
  };
  const token = tokenBody.data?.obtainKrakenToken?.token;
  if (!token) throw new OctopusError('Could not obtain a Kraken token from the API key');

  const accountsResponse = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query: '{ viewer { accounts { number } } }' }),
  });
  const accountsBody = (await accountsResponse.json()) as {
    data?: { viewer?: { accounts?: { number: string }[] } | null };
  };
  const accounts = accountsBody.data?.viewer?.accounts ?? [];
  if (accounts.length !== 1) {
    throw new OctopusError(`Expected exactly one account, found ${accounts.length}`);
  }
  return accounts[0]!.number;
}

/** Import meter points only; export would need its own consumption table. */
export async function fetchAccount(
  apiKey: string,
  accountNumber: string,
  fetchImpl: Fetcher = fetch,
): Promise<Account> {
  const body = await getJson<{
    properties: { electricity_meter_points?: MeterPoint[] }[];
  }>(`${REST}/accounts/${accountNumber}/`, apiKey, fetchImpl);

  const meterPoints = body.properties
    .flatMap((property) => property.electricity_meter_points ?? [])
    .filter((point) => !point.is_export);

  return { number: accountNumber, meterPoints };
}

/** `E-1R-AGILE-24-10-01-C` -> `AGILE-24-10-01`, which is what tariff endpoints key on. */
export function productCodeFromTariff(tariffCode: string): string {
  const match = /^[A-Z]-\d+R-(.+)-[A-Z]$/.exec(tariffCode);
  if (!match) throw new OctopusError(`Unrecognised tariff code: ${tariffCode}`);
  return match[1]!;
}

/**
 * `periodFrom` is required, not optional: without it Octopus returns a short
 * recent window with a `count` matching the truncated set, so it looks complete.
 */
export async function fetchConsumption(
  apiKey: string,
  mpan: string,
  serial: string,
  periodFrom: string,
  fetchImpl: Fetcher = fetch,
): Promise<ConsumptionReading[]> {
  const url =
    `${REST}/electricity-meter-points/${mpan}/meters/${serial}/consumption/` +
    `?period_from=${encodeURIComponent(periodFrom)}&page_size=25000&order_by=period`;
  return getAllPages<ConsumptionReading>(url, apiKey, fetchImpl);
}

function tariffUrl(tariffCode: string, kind: string, periodFrom: string): string {
  const product = productCodeFromTariff(tariffCode);
  return (
    `${REST}/products/${product}/electricity-tariffs/${tariffCode}/${kind}/` +
    `?period_from=${encodeURIComponent(periodFrom)}&page_size=1500`
  );
}

export async function fetchUnitRates(
  apiKey: string,
  tariffCode: string,
  periodFrom: string,
  fetchImpl: Fetcher = fetch,
): Promise<RatePeriod[]> {
  return getAllPages<RatePeriod>(
    tariffUrl(tariffCode, 'standard-unit-rates', periodFrom),
    apiKey,
    fetchImpl,
  );
}

export async function fetchStandingCharges(
  apiKey: string,
  tariffCode: string,
  periodFrom: string,
  fetchImpl: Fetcher = fetch,
): Promise<RatePeriod[]> {
  return getAllPages<RatePeriod>(
    tariffUrl(tariffCode, 'standing-charges', periodFrom),
    apiKey,
    fetchImpl,
  );
}
