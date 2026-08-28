import { index, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Half-hourly import readings from the smart meter. Octopus reports one row per
 * 30-minute slot; `interval_start` is unique because only one meter reports at a
 * time, and `meter_serial` is kept for provenance across meter exchanges.
 *
 * All timestamps are normalised to UTC on ingest (see `toUtcIso`) so they sort
 * lexicographically and BETWEEN works directly in SQL. The API itself is not
 * consistent — consumption arrives in local time with an offset.
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
 * Unit rates per tariff. Agile publishes one row per 30-minute slot; fixed and
 * variable tariffs publish a handful of long-lived rows. Both shapes fit here,
 * which is what makes the Agile-versus-Flexible counterfactual a single join
 * rather than a second ingest path.
 *
 * `valid_to` is null for the open-ended current rate.
 */
export const unitRates = sqliteTable(
  'unit_rates',
  {
    tariffCode: text('tariff_code').notNull(),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
    pIncVat: real('p_inc_vat').notNull(),
    pExcVat: real('p_exc_vat').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tariffCode, table.validFrom] }),
    index('unit_rates_valid_from_idx').on(table.validFrom),
  ],
);

/** Daily standing charges, same shape and lifecycle as unit rates. */
export const standingCharges = sqliteTable(
  'standing_charges',
  {
    tariffCode: text('tariff_code').notNull(),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
    pIncVat: real('p_inc_vat').notNull(),
    pExcVat: real('p_exc_vat').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tariffCode, table.validFrom] })],
);

/**
 * Which tariff was actually in force when. Joining consumption through this to
 * `unit_rates` gives the real bill; joining it to a different tariff code gives
 * the counterfactual.
 */
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
