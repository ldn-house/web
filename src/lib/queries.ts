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

/**
 * Half-hourly kWh derived from the Home Mini's cumulative register, for slots
 * the billing feed has not delivered yet. The bucket containing `now` is still
 * filling and is left out.
 */
export async function telemetryBetween(from: string, to: string): Promise<Slot[]> {
  const rows = await db()
    .select({ readAt: schema.telemetry.readAt, registerWh: schema.telemetry.registerWh })
    .from(schema.telemetry)
    .where(
      and(
        gte(
          schema.telemetry.readAt,
          new Date(Date.parse(from) - 1800_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        ),
        lt(schema.telemetry.readAt, to),
      ),
    )
    .orderBy(asc(schema.telemetry.readAt));

  const cutoff = Date.now() - 1800_000;
  const slots: Slot[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.readAt < from || Date.parse(row.readAt) > cutoff) continue;
    slots.push({
      start: row.readAt,
      kwh: (row.registerWh - rows[i - 1]!.registerWh) / 1000,
    });
  }
  return slots;
}

export async function latestDemand(): Promise<{ readAt: string; watts: number } | null> {
  const [row] = await db()
    .select({ readAt: schema.telemetry.readAt, watts: schema.telemetry.demandW })
    .from(schema.telemetry)
    .orderBy(desc(schema.telemetry.readAt))
    .limit(1);
  return row ?? null;
}
