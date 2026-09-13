CREATE TABLE `live_power_cache` (
	`id` integer PRIMARY KEY NOT NULL,
	`reading` text,
	`next_fetch_at` integer NOT NULL,
	`lease_token` text
);
