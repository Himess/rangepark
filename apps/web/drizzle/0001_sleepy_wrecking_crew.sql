CREATE TABLE `hosted_return_monitor` (
	`id` text PRIMARY KEY NOT NULL,
	`lease_owner` text NOT NULL,
	`lease_until` integer NOT NULL,
	`slot` integer NOT NULL,
	`observation` text,
	`report` text,
	`recent` text DEFAULT '[]' NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
