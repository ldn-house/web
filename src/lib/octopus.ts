/**
 * REST serves consumption and tariff data (Basic auth, API key as username).
 * Account discovery is GraphQL-only — `GET /v1/accounts/` returns 403.
 */

import { type MeterSlot, meterSlots } from './consumption';
import { addLondonDays, londonMidnight } from './format';
import { retryAfterMs } from './live-polling';

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
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OctopusError';
  }

  get rateLimited() {
    return (
      this.status === 429 || this.code === 'KT-CT-1199' || this.code === 'KT-GB-4042'
    );
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
async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: Fetcher,
  token?: string,
): Promise<T> {
  const response = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const retry = retryAfterMs(response.headers.get('Retry-After'));
  if (!response.ok) {
    throw new OctopusError(
      'GraphQL request failed',
      response.status,
      undefined,
      retry === null ? undefined : Math.ceil(retry / 1000),
    );
  }
  const body = (await response.json()) as {
    data?: T;
    errors?: { message: string; extensions?: { errorCode?: string } }[];
  };
  if (body.errors?.length) {
    // Preserve throttling even when another field also failed in this response.
    const error =
      body.errors.find((error) =>
        ['KT-CT-1199', 'KT-GB-4042'].includes(error.extensions?.errorCode ?? ''),
      ) ?? body.errors[0]!;
    throw new OctopusError(
      error.message,
      response.status,
      error.extensions?.errorCode,
      retry === null ? undefined : Math.ceil(retry / 1000),
    );
  }
  return body.data as T;
}

export async function krakenToken(
  apiKey: string,
  fetchImpl: Fetcher = fetch,
): Promise<string> {
  const data = await graphql<{ obtainKrakenToken?: { token?: string } | null }>(
    'mutation($a: String!){ obtainKrakenToken(input:{APIKey:$a}){ token } }',
    { a: apiKey },
    fetchImpl,
  );
  const token = data.obtainKrakenToken?.token;
  if (!token) throw new OctopusError('Could not obtain a Kraken token from the API key');
  return token;
}

async function discoverAccountNumberWithToken(
  token: string,
  fetchImpl: Fetcher,
): Promise<string> {
  const data = await graphql<{ viewer?: { accounts?: { number: string }[] } | null }>(
    '{ viewer { accounts { number } } }',
    {},
    fetchImpl,
    token,
  );
  const accounts = data.viewer?.accounts ?? [];
  if (accounts.length !== 1) {
    throw new OctopusError(`Expected exactly one account, found ${accounts.length}`);
  }
  return accounts[0]!.number;
}

export async function discoverAccountNumber(
  apiKey: string,
  fetchImpl: Fetcher = fetch,
): Promise<string> {
  return discoverAccountNumberWithToken(await krakenToken(apiKey, fetchImpl), fetchImpl);
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

/** The Home Mini's device id, or null when the account has none. */
async function discoverDeviceIdWithToken(
  accountNumber: string,
  token: string,
  fetchImpl: Fetcher,
): Promise<string | null> {
  const data = await graphql<{
    account?: {
      electricityAgreements?: {
        meterPoint?: { meters?: { smartDevices?: { deviceId: string }[] }[] };
      }[];
    } | null;
  }>(
    'query($n: String!){ account(accountNumber:$n){ electricityAgreements(active:true){ meterPoint{ meters{ smartDevices{ deviceId } } } } } }',
    { n: accountNumber },
    fetchImpl,
    token,
  );
  for (const agreement of data.account?.electricityAgreements ?? []) {
    for (const meter of agreement.meterPoint?.meters ?? []) {
      const device = meter.smartDevices?.[0];
      if (device) return device.deviceId;
    }
  }
  return null;
}

export async function discoverDeviceId(
  apiKey: string,
  accountNumber: string,
  fetchImpl: Fetcher = fetch,
): Promise<string | null> {
  return discoverDeviceIdWithToken(
    accountNumber,
    await krakenToken(apiKey, fetchImpl),
    fetchImpl,
  );
}

export interface TelemetryReading {
  readAt: string;
  /** Watts. */
  demand: string;
  /** Cumulative import register, watt-hours. */
  consumption: string;
  /** Energy consumed in this period, in Wh. Null means unavailable, not zero. */
  consumptionDelta?: string | null;
}

export interface LiveDemand {
  readAt: string;
  watts: number;
  consumption: MeterSlot[];
}

/** Half-hourly Home Mini telemetry; current to the minute, unlike the billing feed. */
export async function fetchTelemetry(
  apiKey: string,
  deviceId: string,
  start: string,
  end: string,
  fetchImpl: Fetcher = fetch,
): Promise<TelemetryReading[]> {
  const token = await krakenToken(apiKey, fetchImpl);
  const data = await graphql<{ smartMeterTelemetry?: TelemetryReading[] | null }>(
    'query($d: String!, $s: DateTime!, $e: DateTime!){ smartMeterTelemetry(deviceId:$d, grouping:HALF_HOURLY, start:$s, end:$e){ readAt demand consumption consumptionDelta } }',
    { d: deviceId, s: start, e: end },
    fetchImpl,
    token,
  );
  return data.smartMeterTelemetry ?? [];
}

/** Live demand and recent half-hours, including the period still accumulating. */
export async function fetchLiveDemand(
  apiKey: string,
  now = new Date(),
  fetchImpl: Fetcher = fetch,
): Promise<LiveDemand | null> {
  const token = await krakenToken(apiKey, fetchImpl);
  try {
    return await liveDemandWithToken(token, now, fetchImpl);
  } catch (error) {
    if (!(error instanceof OctopusError) || !error.rateLimited) throw error;
    // The GraphQL error often has no Retry-After. Ask for the actual reset time
    // once, without making another telemetry request. If unavailable, the caller
    // uses a conservative one-hour cooldown.
    const cooldown = await rateLimitCooldown(token, now.getTime(), fetchImpl).catch(
      () => undefined,
    );
    throw new OctopusError(
      error.message,
      error.status,
      error.code,
      Math.max(error.retryAfterSeconds ?? 0, cooldown ?? 0) || undefined,
    );
  }
}

async function rateLimitCooldown(token: string, now: number, fetchImpl: Fetcher) {
  const data = await graphql<{
    rateLimitInfo?: {
      pointsAllowanceRateLimit?: { ttl?: number; isBlocked?: boolean };
      fieldSpecificRateLimits?: {
        edges: { node?: { ttl?: number; isBlocked?: boolean } }[];
      };
    };
  }>(
    `query {
    rateLimitInfo {
      pointsAllowanceRateLimit { ttl isBlocked }
      fieldSpecificRateLimits(first:10, fields:["Query.smartMeterTelemetry", "Mutation.obtainKrakenToken"]) {
        edges { node { ttl isBlocked } }
      }
    }
  }`,
    {},
    fetchImpl,
    token,
  );
  const info = data.rateLimitInfo;
  const limits = [
    info?.pointsAllowanceRateLimit,
    ...(info?.fieldSpecificRateLimits?.edges ?? []).map((edge) => edge.node),
  ];
  const delays = limits.flatMap((limit) => {
    if (!limit?.isBlocked || !Number.isFinite(limit.ttl) || limit.ttl! <= 0) return [];
    // The live API returns epoch seconds; some schema versions document a duration.
    return [
      Math.max(0, limit.ttl! > 1_000_000_000 ? limit.ttl! - now / 1000 : limit.ttl!),
    ];
  });
  return delays.length ? Math.ceil(Math.max(...delays)) + 5 : undefined;
}

async function liveDemandWithToken(
  token: string,
  now: Date,
  fetchImpl: Fetcher,
): Promise<LiveDemand | null> {
  const accountNumber = await discoverAccountNumberWithToken(token, fetchImpl);
  const deviceId = await discoverDeviceIdWithToken(accountNumber, token, fetchImpl);
  if (!deviceId) return null;

  const end = now.toISOString();
  const start = new Date(now.getTime() - 2 * 60_000).toISOString();
  const data = await graphql<{
    smartMeterTelemetry?: TelemetryReading[] | null;
    halfHourly?: TelemetryReading[] | null;
  }>(
    `query($d: String!, $s: DateTime!, $e: DateTime!, $h: DateTime!) {
      smartMeterTelemetry(deviceId:$d, grouping:TEN_SECONDS, start:$s, end:$e) {
        readAt demand
      }
      halfHourly: smartMeterTelemetry(deviceId:$d, grouping:HALF_HOURLY, start:$h, end:$e) {
        readAt consumptionDelta
      }
    }`,
    { d: deviceId, s: start, e: end, h: addLondonDays(londonMidnight(end), -1) },
    fetchImpl,
    token,
  );
  const latest = (data.smartMeterTelemetry ?? []).reduce<TelemetryReading | null>(
    (best, reading) => (!best || reading.readAt > best.readAt ? reading : best),
    null,
  );
  if (!latest) return null;
  const age = now.getTime() - Date.parse(latest.readAt);
  if (!Number.isFinite(age) || age < 0 || age > 2 * 60_000) return null;
  const watts =
    latest.demand == null || latest.demand.trim() === ''
      ? Number.NaN
      : Number(latest.demand);
  return Number.isFinite(watts)
    ? {
        readAt: latest.readAt,
        watts,
        consumption: meterSlots(data.halfHourly ?? [], latest.readAt),
      }
    : null;
}
