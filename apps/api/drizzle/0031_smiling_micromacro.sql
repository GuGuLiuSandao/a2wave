CREATE INDEX `agents_user_id_idx` ON `agents` (`user_id`);--> statement-breakpoint
CREATE INDEX `chat_messages_run_id_idx` ON `chat_messages` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_steps_run_id_idx` ON `run_steps` (`run_id`);--> statement-breakpoint
CREATE INDEX `runs_initiator_agent_id_idx` ON `runs` (`initiator_agent_id`);--> statement-breakpoint
CREATE INDEX `runs_user_id_idx` ON `runs` (`user_id`);