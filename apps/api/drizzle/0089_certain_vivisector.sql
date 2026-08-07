ALTER TABLE `agents` ADD `slack_config` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `discord_config` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `trigger_event_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_native_chat_event_unique` ON `runs` (`initiator_agent_id`,`trigger_source`,`trigger_event_id`) WHERE trigger_source IN ('slack', 'discord') AND trigger_event_id IS NOT NULL;