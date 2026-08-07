CREATE TABLE `artifact_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`created_by` text,
	`access_level` text NOT NULL,
	`password_hash` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	`created_at` integer,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifact_shares_artifact_id_idx` ON `artifact_shares` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `artifact_shares_expires_at_idx` ON `artifact_shares` (`expires_at`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `kind` text DEFAULT 'file' NOT NULL;