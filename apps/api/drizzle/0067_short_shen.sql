CREATE TABLE `feishu_card_callbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`trigger_session_id` text NOT NULL,
	`previous_chat_id` text,
	`chat_id` text NOT NULL,
	`chat_type` text,
	`thread_id` text,
	`spec` text NOT NULL,
	`message_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feishu_card_callbacks_agent_id_idx` ON `feishu_card_callbacks` (`agent_id`);--> statement-breakpoint
CREATE INDEX `feishu_card_callbacks_expires_at_idx` ON `feishu_card_callbacks` (`expires_at`);