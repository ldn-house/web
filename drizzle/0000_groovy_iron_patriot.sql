CREATE TABLE `agreements` (
	`tariff_code` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	PRIMARY KEY(`tariff_code`, `valid_from`)
);
--> statement-breakpoint
CREATE TABLE `consumption` (
	`interval_start` text PRIMARY KEY NOT NULL,
	`interval_end` text NOT NULL,
	`kwh` real NOT NULL,
	`meter_serial` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `consumption_interval_end_idx` ON `consumption` (`interval_end`);--> statement-breakpoint
CREATE TABLE `standing_charges` (
	`tariff_code` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`p_inc_vat` real NOT NULL,
	`p_exc_vat` real NOT NULL,
	PRIMARY KEY(`tariff_code`, `valid_from`)
);
--> statement-breakpoint
CREATE TABLE `unit_rates` (
	`tariff_code` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`p_inc_vat` real NOT NULL,
	`p_exc_vat` real NOT NULL,
	PRIMARY KEY(`tariff_code`, `valid_from`)
);
--> statement-breakpoint
CREATE INDEX `unit_rates_valid_from_idx` ON `unit_rates` (`valid_from`);