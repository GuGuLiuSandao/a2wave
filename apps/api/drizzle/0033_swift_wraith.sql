CREATE INDEX `runs_status_created_at_idx` ON `runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_user_id_created_at_idx` ON `runs` (`user_id`,`created_at`);