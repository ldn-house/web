CREATE TABLE `enrol_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`browser_hash` text,
	`client_hash` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `enrol_codes_browser_hash_idx` ON `enrol_codes` (`browser_hash`);--> statement-breakpoint
CREATE INDEX `enrol_codes_created_at_idx` ON `enrol_codes` (`created_at`);--> statement-breakpoint
CREATE TABLE `enrol_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`client_hash` text
);
--> statement-breakpoint
CREATE INDEX `enrol_failures_at_idx` ON `enrol_failures` (`at`);