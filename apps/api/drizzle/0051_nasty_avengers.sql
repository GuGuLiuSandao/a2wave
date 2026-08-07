CREATE TABLE `skill_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text DEFAULT 'package' NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `skill_group_ids` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `skills` ADD `group_id` text REFERENCES skill_groups(id) ON UPDATE no action ON DELETE set null;