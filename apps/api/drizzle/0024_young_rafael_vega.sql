ALTER TABLE `agents` ADD `publish_auth_type` text DEFAULT 'api_key';--> statement-breakpoint
ALTER TABLE `agents` ADD `publish_ip_whitelist` text DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `agents` ADD `publish_description` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `published_at` integer;