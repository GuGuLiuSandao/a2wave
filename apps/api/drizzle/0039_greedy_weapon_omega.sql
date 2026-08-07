ALTER TABLE `runs` ADD `trigger_session_id` text;
--> statement-breakpoint
CREATE INDEX `runs_agent_trigger_session_status_created_at_idx` ON `runs` (`initiator_agent_id`,`trigger_session_id`,`status`,`created_at`);
