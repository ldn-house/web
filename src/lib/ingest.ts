import { sql } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import {
  discoverAccountNumber,
  type Fetcher,
  fetchAccount,
  fetchConsumption,
  fetchStandingCharges,
  fetchUnitRates,
} from './octopus';

/**
 * D1 allows at most 100 bound parameters per statement, so multi-row inserts
 * are chunked by column count rather than by a round number of rows.
 */
const MAX_BOUND_PARAMS = 100;

/** How many statements to send in one `batch()` round trip. */
const STATEMENTS_PER_BATCH = 50;

/**
 * Where a first-time backfill starts. Earlier than any smart meter data, so the
 * API decides the real lower bound rather than this constant.
 */
export const BACKFILL_FLOOR = '2020-01-01T00:00:00Z';

export interface IngestSummary {
  consumptionRows: number;
  unitRateRows: number;
  standingChargeRows: number;
  agreementRows: number;
  consumptionSince: string;
  ratesSince: string;
}

/**
 * Normalises a timestamp to UTC with second precision.
 *
 * Octopus is not consistent: consumption comes back in local time with an
 * offset (`2026-08-27T01:00:00+01:00` during BST) while tariff endpoints
 * always return `Z`. Storing both verbatim would break the lexicographic
 * comparisons that price consumption against rates, silently and only for
 * readings inside British Summer Time.
 */
export function toUtcIso(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new TypeError(`Unparseable timestamp: ${timestamp}`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Null-tolerant {@link toUtcIso}, for the open-ended `valid_to`. */
function toUtcIsoOrNull(timestamp: string | null): string | null {
  return timestamp === null ? null : toUtcIso(timestamp);
}

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Chunked upsert honouring D1's bound-parameter ceiling. Returns the number of
 * rows sent, not the number changed — re-ingesting an overlapping window is
 * expected and idempotent.
 */
async function upsertAll<T extends Record<string, unknown>>(
  db: DrizzleD1Database<typeof schema>,
  table: Parameters<DrizzleD1Database<typeof schema>['insert']>[0],
  rows: readonly T[],
  conflictTarget: unknown[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const columnCount = Object.keys(rows[0]!).length;
  const rowsPerStatement = Math.max(Math.floor(MAX_BOUND_PARAMS / columnCount), 1);

  const statements = chunk(rows, rowsPerStatement).map((group) =>
    db
      .insert(table)
      .values(group as never)
      .onConflictDoNothing({ target: conflictTarget as never }),
  );

  for (const group of chunk(statements, STATEMENTS_PER_BATCH)) {
    await db.batch(group as [(typeof statements)[number], ...typeof statements]);
  }
  return rows.length;
}

/**
 * Resume points are tracked per table rather than shared. Consumption is
 * written before rates, so a run that dies in between would otherwise advance
 * a single watermark past rates that were never fetched.
 */
async function watermarks(
  db: DrizzleD1Database<typeof schema>,
): Promise<{ consumption: string | null; rates: string | null }> {
  const [consumptionRow] = await db
    .select({ latest: sql<string | null>`max(${schema.consumption.intervalEnd})` })
    .from(schema.consumption);
  const [ratesRow] = await db
    .select({ latest: sql<string | null>`max(${schema.unitRates.validFrom})` })
    .from(schema.unitRates);
  return {
    consumption: consumptionRow?.latest ?? null,
    rates: ratesRow?.latest ?? null,
  };
}

/**
 * Pulls everything new from Octopus into D1.
 *
 * Incremental by default: consumption resumes from the stored watermark, and
 * tariff data is re-fetched from the same point because Agile publishes
 * tomorrow's rates during the afternoon. Pass `since` to force a wider window.
 */
export async function ingest(
  env: Env,
  options: { since?: string; fetchImpl?: Fetcher } = {},
): Promise<IngestSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const db = drizzle(env.DB, { schema });
  const key = env.OCTOPUS_API_KEY;

  const marks = await watermarks(db);
  const consumptionSince = options.since ?? marks.consumption ?? BACKFILL_FLOOR;
  // Agile publishes the next day's rates mid-afternoon, so rates are re-read
  // from the last stored slot rather than from "now".
  const ratesSince = options.since ?? marks.rates ?? BACKFILL_FLOOR;

  const accountNumber = await discoverAccountNumber(key, fetchImpl);
  const account = await fetchAccount(key, accountNumber, fetchImpl);

  const summary: IngestSummary = {
    consumptionRows: 0,
    unitRateRows: 0,
    standingChargeRows: 0,
    agreementRows: 0,
    consumptionSince,
    ratesSince,
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
    );

    for (const tariff of new Set(point.agreements.map((a) => a.tariff_code))) {
      const [rates, standing] = await Promise.all([
        fetchUnitRates(key, tariff, ratesSince, fetchImpl),
        fetchStandingCharges(key, tariff, ratesSince, fetchImpl),
      ]);

      summary.unitRateRows += await upsertAll(
        db,
        schema.unitRates,
        rates.map((r) => ({
          tariffCode: tariff,
          validFrom: toUtcIso(r.valid_from),
          validTo: toUtcIsoOrNull(r.valid_to),
          pIncVat: r.value_inc_vat,
          pExcVat: r.value_exc_vat,
        })),
        [schema.unitRates.tariffCode, schema.unitRates.validFrom],
      );

      summary.standingChargeRows += await upsertAll(
        db,
        schema.standingCharges,
        standing.map((r) => ({
          tariffCode: tariff,
          validFrom: toUtcIso(r.valid_from),
          validTo: toUtcIsoOrNull(r.valid_to),
          pIncVat: r.value_inc_vat,
          pExcVat: r.value_exc_vat,
        })),
        [schema.standingCharges.tariffCode, schema.standingCharges.validFrom],
      );
    }
  }

  return summary;
}
