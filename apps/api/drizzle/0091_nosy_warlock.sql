CREATE TABLE `cli_installations` (
	`kind` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`installed_version` text,
	`last_error` text,
	`last_output` text,
	`updated_at` integer NOT NULL
);
