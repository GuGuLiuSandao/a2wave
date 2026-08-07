-- Add new columns to agents table for Agent editing and management
ALTER TABLE `agents` ADD COLUMN `icon` text DEFAULT '🤖' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `system_prompt` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `skills` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `publish_status` text DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `api_key` text;
