'use server';

import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export interface Slot {
  /** ISO 8601 UTC, as stored. */
  start: string;
  kwh: number;
}

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
