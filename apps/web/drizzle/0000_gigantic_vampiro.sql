CREATE TABLE `positions` (
	`token_id` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`observation` text NOT NULL,
	`block_number` integer NOT NULL,
	`updated_at` integer NOT NULL
);
