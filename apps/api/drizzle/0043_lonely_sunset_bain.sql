CREATE TABLE IF NOT EXISTS `kb_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`source_type` text NOT NULL,
	`feishu_doc_token` text,
	`feishu_doc_type` text,
	`feishu_url` text,
	`feishu_app_id` text,
	`feishu_app_secret` text,
	`original_filename` text,
	`mime_type` text,
	`storage_path` text,
	`content_hash` text,
	`file_size` integer,
	`sync_status` text DEFAULT 'idle' NOT NULL,
	`last_sync_at` integer,
	`last_sync_error` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
SELECT 1;