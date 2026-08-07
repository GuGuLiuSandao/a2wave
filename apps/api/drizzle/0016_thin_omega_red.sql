CREATE TABLE `settings` (
	`category` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`category`, `key`)
);
