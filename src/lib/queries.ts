'use server';

import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, gt, gte, isNull, lte, or } from 'drizzle-orm';
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

export async function recentConsumption(hours = 48): Promise<Slot[]> {
  const client = db();
  const [latest] = await client
    .select({ intervalEnd: schema.consumption.intervalEnd })
    .from(schema.consumption)
    .orderBy(desc(schema.consumption.intervalEnd))
    .limit(1);
  if (!latest) return [];

  const from = new Date(Date.parse(latest.intervalEnd) - hours * 3600_000).toISOString();
  return client
    .select({ start: schema.consumption.intervalStart, kwh: schema.consumption.kwh })
    .from(schema.consumption)
    .where(gte(schema.consumption.intervalStart, from))
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

/** Agile publishes tomorrow's prices mid-afternoon, so this runs past now. */
export async function upcomingRates(from: string): Promise<RateSlot[]> {
  const tariffCode = await tariffInForce(new Date().toISOString());
  if (!tariffCode) return [];

  return db()
    .select({ start: schema.unitRates.validFrom, pIncVat: schema.unitRates.pIncVat })
    .from(schema.unitRates)
    .where(
      and(
        eq(schema.unitRates.tariffCode, tariffCode),
        gte(schema.unitRates.validFrom, from),
      ),
    )
    .orderBy(asc(schema.unitRates.validFrom))
    .limit(96);
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
