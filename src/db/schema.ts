import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

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

/** Home Mini readings: `register_wh` is the meter's cumulative import register. */
export const telemetry = sqliteTable('telemetry', {
  readAt: text('read_at').primaryKey(),
  demandW: real('demand_w').notNull(),
  registerWh: real('register_wh').notNull(),
  /** API consumptionDelta for a completed half-hour; legacy/unfinished rows are null. */
  consumptionWh: real('consumption_wh'),
});

export type TelemetryRow = typeof telemetry.$inferSelect;

/** One shared reading and fetch lease, including cooldowns after upstream failures. */
export const livePowerCache = sqliteTable('live_power_cache', {
  id: integer('id').primaryKey(),
  reading: text('reading'),
  nextFetchAt: integer('next_fetch_at').notNull(),
  leaseToken: text('lease_token'),
});

/**
 * One-time enrolment codes, stored as SHA-256 hashes. `browser` codes are bound
 * to the requesting browser's pending cookie and confirmed by Home Assistant;
 * `link` codes are minted by Home Assistant and redeemed from a link.
 */
export const enrolCodes = sqliteTable(
  'enrol_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    kind: text('kind', { enum: ['browser', 'link'] }).notNull(),
    browserHash: text('browser_hash'),
    clientHash: text('client_hash'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    confirmedAt: integer('confirmed_at'),
    consumedAt: integer('consumed_at'),
  },
  (table) => [
    index('enrol_codes_browser_hash_idx').on(table.browserHash),
    index('enrol_codes_created_at_idx').on(table.createdAt),
  ],
);

/** Rejected confirmations and redemptions, for rate limiting. */
export const enrolFailures = sqliteTable(
  'enrol_failures',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    kind: text('kind').notNull(),
    clientHash: text('client_hash'),
  },
  (table) => [index('enrol_failures_at_idx').on(table.at)],
);
