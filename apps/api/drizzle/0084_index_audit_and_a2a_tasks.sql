CREATE INDEX `a2a_tasks_updated_at_idx` ON `a2a_tasks` (`updated_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_created_at_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_user_id_created_at_idx` ON `audit_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_resource_created_at_idx` ON `audit_logs` (`resource`,`created_at`);