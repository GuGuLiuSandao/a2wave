-- SCM Sources: replace tools + path_locks with scm_sources
-- Create scm_sources table
CREATE TABLE `scm_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`config` text NOT NULL,
	`local_path` text NOT NULL,
	`sync_status` text DEFAULT 'idle' NOT NULL,
	`last_sync_at` integer,
	`last_sync_error` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scm_sources_local_path_unique` ON `scm_sources` (`local_path`);
--> statement-breakpoint
-- Add new columns to agents
ALTER TABLE `agents` ADD `workspace_type` text DEFAULT 'temp' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agents` ADD `scm_source_id` text REFERENCES scm_sources(id);
--> statement-breakpoint
-- Drop old tables (SQLite does not support DROP COLUMN, so we keep tool_ids for now but ignore it)
DROP TABLE IF EXISTS `path_locks`;
--> statement-breakpoint
DROP TABLE IF EXISTS `tools`;
