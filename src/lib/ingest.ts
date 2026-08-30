import { sql } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import {
  discoverAccountNumber,
  discoverDeviceId,
  type Fetcher,
  fetchAccount,
  fetchConsumption,
  fetchStandingCharges,
  fetchTelemetry,
  fetchUnitRates,
  type RatePeriod,
} from './octopus';

/** D1 caps a statement at 100 bound parameters. */
const MAX_BOUND_PARAMS = 100;

const STATEMENTS_PER_BATCH = 50;

/** Earlier than any smart meter data, so the API decides the real lower bound. */
export const BACKFILL_FLOOR = '2020-01-01T00:00:00Z';

/** Readings can be revised or land late, so runs re-read behind the watermark. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Stored instead of null, since SQLite treats nulls in a unique index as distinct. */
export const ANY_PAYMENT_METHOD = 'ANY';

export interface IngestSummary {
  consumptionRows: number;
  unitRateRows: number;
  standingChargeRows: number;
  agreementRows: number;
  telemetryRows: number;
  consumptionSince: string;
}

/**
 * Octopus returns consumption in local time (`+01:00` under BST) but tariff
 * data in `Z`. Stored verbatim, a BST reading sorts after the rate that applied
 * to it, mis-pricing every summer reading by an hour.
 */
export function toUtcIso(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new TypeError(`Unparseable timestamp: ${timestamp}`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toUtcIsoOrNull(timestamp: string | null): string | null {
  return timestamp === null ? null : toUtcIso(timestamp);
}

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Updates on conflict rather than ignoring: `valid_to` starts null and is filled
 * in once the next period begins, so ignoring would pin the first version.
 */
async function upsertAll<T extends Record<string, unknown>>(
  db: DrizzleD1Database<typeof schema>,
  table: Parameters<DrizzleD1Database<typeof schema>['insert']>[0],
  rows: readonly T[],
  conflictTarget: unknown[],
  mutableKeys: readonly string[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const columnCount = Object.keys(rows[0]!).length;
  const rowsPerStatement = Math.max(Math.floor(MAX_BOUND_PARAMS / columnCount), 1);

  // Keys are the schema's property names; `excluded` needs the SQL column names.
  const set = Object.fromEntries(
    mutableKeys.map((key) => {
      const column = (table as unknown as Record<string, { name: string }>)[key];
      if (!column) throw new TypeError(`Unknown column ${key}`);
      return [key, sql.raw(`excluded.${column.name}`)];
    }),
  );

  const statements = chunk(rows, rowsPerStatement).map((group) =>
    db
      .insert(table)
      .values(group as never)
      .onConflictDoUpdate({ target: conflictTarget as never, set: set as never }),
  );

  for (const group of chunk(statements, STATEMENTS_PER_BATCH)) {
    await db.batch(group as [(typeof statements)[number], ...typeof statements]);
  }
  return rows.length;
}

function shiftBack(timestamp: string): string {
  return toUtcIso(new Date(Date.parse(timestamp) - LOOKBACK_MS).toISOString());
}

/**
 * Resume points are per table and per tariff. A single watermark would let a run
 * that wrote unit rates but died before standing charges resume past the gap,
 * and a maximum taken across tariffs would skip a tariff publishing behind it.
 */
async function watermarks(db: DrizzleD1Database<typeof schema>) {
  const [consumptionRow] = await db
    .select({ latest: sql<string | null>`max(${schema.consumption.intervalEnd})` })
    .from(schema.consumption);

  const perTariff = async (
    table: typeof schema.unitRates | typeof schema.standingCharges,
  ) => {
    const rows = await db
      .select({
        tariffCode: table.tariffCode,
        latest: sql<string>`max(${table.validFrom})`,
      })
      .from(table)
      .groupBy(table.tariffCode);
    return new Map(rows.map((row) => [row.tariffCode, row.latest]));
  };

  return {
    consumption: consumptionRow?.latest ?? null,
    unitRates: await perTariff(schema.unitRates),
    standingCharges: await perTariff(schema.standingCharges),
  };
}

export async function ingest(
  env: Env,
  options: { since?: string; fetchImpl?: Fetcher } = {},
): Promise<IngestSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const db = drizzle(env.DB, { schema });
  const key = env.OCTOPUS_API_KEY;

  const marks = await watermarks(db);
  const consumptionSince =
    options.since ?? (marks.consumption ? shiftBack(marks.consumption) : BACKFILL_FLOOR);

  const accountNumber = await discoverAccountNumber(key, fetchImpl);
  const account = await fetchAccount(key, accountNumber, fetchImpl);

  const summary: IngestSummary = {
    consumptionRows: 0,
    unitRateRows: 0,
    standingChargeRows: 0,
    agreementRows: 0,
    telemetryRows: 0,
    consumptionSince,
  };

  for (const point of account.meterPoints) {
    for (const meter of point.meters) {
      const readings = await fetchConsumption(
        key,
        point.mpan,
        meter.serial_number,
        consumptionSince,
        fetchImpl,
      );
      summary.consumptionRows += await upsertAll(
        db,
        schema.consumption,
        readings.map((r) => ({
          intervalStart: toUtcIso(r.interval_start),
          intervalEnd: toUtcIso(r.interval_end),
          kwh: r.consumption,
          meterSerial: meter.serial_number,
        })),
        [schema.consumption.intervalStart],
        ['intervalEnd', 'kwh', 'meterSerial'],
      );
    }

    summary.agreementRows += await upsertAll(
      db,
      schema.agreements,
      point.agreements.map((a) => ({
        tariffCode: a.tariff_code,
        validFrom: toUtcIso(a.valid_from),
        validTo: toUtcIsoOrNull(a.valid_to),
      })),
      [schema.agreements.tariffCode, schema.agreements.validFrom],
      ['validTo'],
    );

    const rateColumns = ['validTo', 'pIncVat', 'pExcVat'];

    for (const tariff of new Set(point.agreements.map((a) => a.tariff_code))) {
      const [rates, standing] = await Promise.all([
        fetchUnitRates(
          key,
          tariff,
          marks.unitRates.get(tariff) ?? BACKFILL_FLOOR,
          fetchImpl,
        ),
        fetchStandingCharges(
          key,
          tariff,
          marks.standingCharges.get(tariff) ?? BACKFILL_FLOOR,
          fetchImpl,
        ),
      ]);

      // Octopus serves rates newest-first and ignores order_by on this
      // endpoint. Writing them oldest-first means a run that dies part way
      // leaves the watermark mid-history, so the next one resumes forward
      // rather than past the gap it never filled.
      const oldestFirst = (a: RatePeriod, b: RatePeriod) =>
        Date.parse(a.valid_from) - Date.parse(b.valid_from);
      rates.sort(oldestFirst);
      standing.sort(oldestFirst);

      const toRow = (r: (typeof rates)[number]) => ({
        tariffCode: tariff,
        validFrom: toUtcIso(r.valid_from),
        paymentMethod: r.payment_method ?? ANY_PAYMENT_METHOD,
        validTo: toUtcIsoOrNull(r.valid_to),
        pIncVat: r.value_inc_vat,
        pExcVat: r.value_exc_vat,
      });

      summary.unitRateRows += await upsertAll(
        db,
        schema.unitRates,
        rates.map(toRow),
        [
          schema.unitRates.tariffCode,
          schema.unitRates.validFrom,
          schema.unitRates.paymentMethod,
        ],
        rateColumns,
      );

      summary.standingChargeRows += await upsertAll(
        db,
        schema.standingCharges,
        standing.map(toRow),
        [
          schema.standingCharges.tariffCode,
          schema.standingCharges.validFrom,
          schema.standingCharges.paymentMethod,
        ],
        rateColumns,
      );
    }
  }

  // Secondary feed: a failure here must not mark the billing ingest as failed.
  try {
    const deviceId = await discoverDeviceId(key, accountNumber, fetchImpl);
    if (deviceId) {
      const [mark] = await db
        .select({ latest: sql<string | null>`max(${schema.telemetry.readAt})` })
        .from(schema.telemetry);
      const start = mark?.latest
        ? toUtcIso(new Date(Date.parse(mark.latest) - 24 * 3_600_000).toISOString())
        : toUtcIso(new Date(Date.now() - 3 * 24 * 3_600_000).toISOString());
      const readings = await fetchTelemetry(
        key,
        deviceId,
        start,
        toUtcIso(new Date().toISOString()),
        fetchImpl,
      );
      summary.telemetryRows += await upsertAll(
        db,
        schema.telemetry,
        readings.map((r) => ({
          readAt: toUtcIso(r.readAt),
          demandW: Number(r.demand),
          registerWh: Number(r.consumption),
        })),
        [schema.telemetry.readAt],
        ['demandW', 'registerWh'],
      );
    }
  } catch (error) {
    console.warn('telemetry ingest skipped', error);
  }

  return summary;
}
