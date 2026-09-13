'use server';

import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { HALF_HOUR_MS, type MeterSlot, type Slot } from './consumption';
import type { UsageRate } from './cost';

export type { Slot } from './consumption';

export interface RateSlot {
  start: string;
  pIncVat: number;
}

const db = () => drizzle(env.DB, { schema });

/**
 * Octopus's Flexible product is the price-capped variable tariff. It cannot be
 * read off `agreements` because the account has since moved to Agile.
 */
const CAP_TARIFF = 'E-1R-VAR-22-11-01-C';
const CAP_PAYMENT_METHOD = 'DIRECT_DEBIT';

export async function consumptionBetween(from: string, to: string): Promise<Slot[]> {
  return db()
    .select({ start: schema.consumption.intervalStart, kwh: schema.consumption.kwh })
    .from(schema.consumption)
    .where(
      and(
        gte(schema.consumption.intervalStart, from),
        lt(schema.consumption.intervalStart, to),
      ),
    )
    .orderBy(asc(schema.consumption.intervalStart));
}

async function tariffInForce(at: string): Promise<string | null> {
  const [agreement] = await db()
    .select({ tariffCode: schema.agreements.tariffCode })
    .from(schema.agreements)
    .where(
      and(
        lte(schema.agreements.validFrom, at),
        or(isNull(schema.agreements.validTo), gt(schema.agreements.validTo, at)),
      ),
    )
    .orderBy(desc(schema.agreements.validFrom))
    .limit(1);
  return agreement?.tariffCode ?? null;
}

export async function ratesBetween(from: string, to: string): Promise<RateSlot[]> {
  const tariffCode = await tariffInForce(new Date().toISOString());
  if (!tariffCode) return [];

  return db()
    .select({ start: schema.unitRates.validFrom, pIncVat: schema.unitRates.pIncVat })
    .from(schema.unitRates)
    .where(
      and(
        eq(schema.unitRates.tariffCode, tariffCode),
        gte(schema.unitRates.validFrom, from),
        lt(schema.unitRates.validFrom, to),
      ),
    )
    .orderBy(asc(schema.unitRates.validFrom));
}

/** Actual usage follows each agreement, including tariffs that have since ended. */
export async function usageRatesBetween(from: string, to: string): Promise<UsageRate[]> {
  const rows = await db()
    .select({
      rateFrom: schema.unitRates.validFrom,
      rateTo: schema.unitRates.validTo,
      agreementFrom: schema.agreements.validFrom,
      agreementTo: schema.agreements.validTo,
      pIncVat: schema.unitRates.pIncVat,
    })
    .from(schema.agreements)
    .innerJoin(
      schema.unitRates,
      eq(schema.unitRates.tariffCode, schema.agreements.tariffCode),
    )
    .where(
      and(
        lt(schema.agreements.validFrom, to),
        or(isNull(schema.agreements.validTo), gt(schema.agreements.validTo, from)),
        lt(schema.unitRates.validFrom, to),
        or(isNull(schema.unitRates.validTo), gt(schema.unitRates.validTo, from)),
        // As with the price-cap comparison, use Direct Debit where a tariff
        // distinguishes payment methods. Agile's method-independent rows use ANY.
        or(
          eq(schema.unitRates.paymentMethod, CAP_PAYMENT_METHOD),
          eq(schema.unitRates.paymentMethod, 'ANY'),
        ),
      ),
    );
  return rows.flatMap((row) => {
    const start = Math.max(
      Date.parse(from),
      Date.parse(row.rateFrom),
      Date.parse(row.agreementFrom),
    );
    const end = Math.min(
      Date.parse(to),
      row.rateTo === null ? Infinity : Date.parse(row.rateTo),
      row.agreementTo === null ? Infinity : Date.parse(row.agreementTo),
    );
    return start < end
      ? [
          {
            from: new Date(start).toISOString(),
            to: new Date(end).toISOString(),
            pIncVat: row.pIncVat,
          },
        ]
      : [];
  });
}

export async function cappedRate(at: string): Promise<number | null> {
  const [rate] = await db()
    .select({ pIncVat: schema.unitRates.pIncVat })
    .from(schema.unitRates)
    .where(
      and(
        eq(schema.unitRates.tariffCode, CAP_TARIFF),
        eq(schema.unitRates.paymentMethod, CAP_PAYMENT_METHOD),
        lte(schema.unitRates.validFrom, at),
        or(isNull(schema.unitRates.validTo), gt(schema.unitRates.validTo, at)),
      ),
    )
    .orderBy(desc(schema.unitRates.validFrom))
    .limit(1);
  return rate?.pIncVat ?? null;
}

/**
 * Completed Home Mini periods. Current consumption is supplied by the live feed.
 * Legacy register averages cannot reliably reconstruct individual periods.
 */
export async function telemetryBetween(
  from: string,
  to: string,
  now = Date.now(),
): Promise<MeterSlot[]> {
  const rows = await db()
    .select({ readAt: schema.telemetry.readAt, wh: schema.telemetry.consumptionWh })
    .from(schema.telemetry)
    .where(and(gte(schema.telemetry.readAt, from), lt(schema.telemetry.readAt, to)))
    .orderBy(asc(schema.telemetry.readAt));

  return rows.flatMap((row) => {
    const end = Date.parse(row.readAt) + HALF_HOUR_MS;
    if (row.wh == null || !Number.isFinite(row.wh) || row.wh < 0 || end > now) return [];
    return [
      {
        start: row.readAt,
        kwh: row.wh / 1000,
        through: new Date(end).toISOString(),
      },
    ];
  });
}

/** Stable SSR summary; null once the half-hourly Home Mini snapshots have gone quiet. */
export async function recentAverageDemand(
  now = Date.now(),
): Promise<{ through: string; watts: number } | null> {
  const rows = await db()
    .select({ readAt: schema.telemetry.readAt, watts: schema.telemetry.demandW })
    .from(schema.telemetry)
    .where(
      gte(
        schema.telemetry.readAt,
        new Date(now - 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ),
    )
    .orderBy(asc(schema.telemetry.readAt));
  const latest = rows.at(-1);
  if (!latest || now - Date.parse(latest.readAt) > 45 * 60_000) return null;
  return {
    through: latest.readAt,
    watts: rows.reduce((sum, row) => sum + row.watts, 0) / rows.length,
  };
}
