CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_preset` integer DEFAULT false NOT NULL,
	`os_requirement` text DEFAULT 'any' NOT NULL,
	`init_script` text,
	`check_script` text,
	`runtime` text,
	`entrypoint` text,
	`config` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `provider_id` text REFERENCES providers(id);