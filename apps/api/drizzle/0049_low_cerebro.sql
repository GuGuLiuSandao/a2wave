CREATE TABLE `feishu_pending_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feishu_pending_messages_agent_id_idx` ON `feishu_pending_messages` (`agent_id`);