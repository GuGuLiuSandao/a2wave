CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text,
	`user_id` text,
	`filename` text NOT NULL,
	`storage_path` text NOT NULL,
	`mime_type` text,
	`size` integer,
	`expires_at` integer,
	`created_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_id_idx` ON `artifacts` (`run_id`);
--> statement-breakpoint
CREATE INDEX `artifacts_user_id_idx` ON `artifacts` (`user_id`);
--> statement-breakpoint
CREATE INDEX `artifacts_expires_at_idx` ON `artifacts` (`expires_at`);
