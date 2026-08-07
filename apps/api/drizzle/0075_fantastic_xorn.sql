CREATE TABLE `attachment_refs` (
	`token` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`token`, `run_id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachment_refs_token_idx` ON `attachment_refs` (`token`);