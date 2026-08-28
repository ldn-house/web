import { index, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Half-hourly import readings. `interval_start` is unique because only one meter
 * reports at a time; `meter_serial` is provenance across meter exchanges.
 * Timestamps are normalised to UTC on ingest so they sort lexicographically.
 */
export const consumption = sqliteTable(
  'consumption',
  {
    intervalStart: text('interval_start').primaryKey(),
    intervalEnd: text('interval_end').notNull(),
    kwh: real('kwh').notNull(),
    meterSerial: text('meter_serial').notNull(),
  },
  (table) => [index('consumption_interval_end_idx').on(table.intervalEnd)],
);

/**
 * Agile publishes a row per 30-minute slot, variable tariffs a handful of
 * long-lived rows. One table for both makes the counterfactual a single join.
 *
 * `payment_method` is part of the key: variable tariffs publish DIRECT_DEBIT and
 * NON_DIRECT_DEBIT rows sharing a `valid_from` at different prices. Tariffs that
 * do not vary by payment method store `ANY` rather than null, because SQLite
 * treats nulls in a unique index as distinct and would admit duplicates.
 */
export const unitRates = sqliteTable(
  'unit_rates',
  {
    tariffCode: text('tariff_code').notNull(),
    validFrom: text('valid_from').notNull(),
    paymentMethod: text('payment_method').notNull(),
    validTo: text('valid_to'),
    pIncVat: real('p_inc_vat').notNull(),
    pExcVat: real('p_exc_vat').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tariffCode, table.validFrom, table.paymentMethod] }),
    index('unit_rates_valid_from_idx').on(table.validFrom),
  ],
);

/** Daily standing charges, same shape and keying as unit rates. */
export const standingCharges = sqliteTable(
  'standing_charges',
  {
    tariffCode: text('tariff_code').notNull(),
    validFrom: text('valid_from').notNull(),
    paymentMethod: text('payment_method').notNull(),
    validTo: text('valid_to'),
    pIncVat: real('p_inc_vat').notNull(),
    pExcVat: real('p_exc_vat').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tariffCode, table.validFrom, table.paymentMethod] }),
  ],
);

/** Which tariff was in force when. Join through it for the real bill, around it for the counterfactual. */
export const agreements = sqliteTable(
  'agreements',
  {
    tariffCode: text('tariff_code').notNull(),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
  },
  (table) => [primaryKey({ columns: [table.tariffCode, table.validFrom] })],
);

export type ConsumptionRow = typeof consumption.$inferSelect;
export type UnitRateRow = typeof unitRates.$inferSelect;
export type StandingChargeRow = typeof standingCharges.$inferSelect;
export type AgreementRow = typeof agreements.$inferSelect;
