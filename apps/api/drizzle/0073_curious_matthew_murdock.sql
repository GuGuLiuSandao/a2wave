ALTER TABLE `scm_sources` ADD `codegraph_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `scm_sources` ADD `codegraph_last_indexed_at` integer;--> statement-breakpoint
ALTER TABLE `scm_sources` ADD `codegraph_last_error` text;