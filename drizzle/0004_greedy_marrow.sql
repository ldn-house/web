CREATE TABLE `home_address` (
	`id` integer PRIMARY KEY NOT NULL,
	`ipv4` text NOT NULL,
	`ipv6_prefix` text,
	`reported_at` integer NOT NULL
);
