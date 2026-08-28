import { index, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** `interval_start` is unique because only one meter reports at a time. */
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
 * `payment_method` is keyed because variable tariffs publish DIRECT_DEBIT and
 * NON_DIRECT_DEBIT rows sharing a `valid_from` at different prices. Tariffs that
 * do not vary by it store `ANY`, not null: SQLite treats nulls in a unique index
 * as distinct and would admit duplicates.
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

/** Join through it for the real bill, around it for a counterfactual. */
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
