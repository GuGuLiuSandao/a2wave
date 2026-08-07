-- Create users table
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text,
	`role` text NOT NULL DEFAULT 'user',
	`password_hash` text,
	`is_active` integer NOT NULL DEFAULT true,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint

-- Create audit_logs table
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text REFERENCES `users`(`id`),
	`action` text NOT NULL,
	`resource` text,
	`resource_id` text,
	`details` text,
	`ip_address` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint

-- Insert default admin user (passwordHash=NULL triggers setup flow)
INSERT INTO `users` (`id`, `username`, `display_name`, `role`, `password_hash`, `is_active`, `created_at`, `updated_at`)
VALUES ('usr_admin', 'admin', 'Administrator', 'admin', NULL, 1, unixepoch(), unixepoch());
--> statement-breakpoint

-- Add userId column to existing tables, default to admin user for existing data
ALTER TABLE `agents` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `agents` SET `user_id` = 'usr_admin';
--> statement-breakpoint

ALTER TABLE `mcp_servers` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `mcp_servers` SET `user_id` = 'usr_admin';
--> statement-breakpoint

ALTER TABLE `skills` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `skills` SET `user_id` = 'usr_admin';
--> statement-breakpoint

ALTER TABLE `scm_sources` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `scm_sources` SET `user_id` = 'usr_admin';
--> statement-breakpoint

ALTER TABLE `runs` ADD COLUMN `user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
UPDATE `runs` SET `user_id` = 'usr_admin';
