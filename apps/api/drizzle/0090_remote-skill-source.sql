ALTER TABLE `skills` ADD `remote_source` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `source_dirty` integer DEFAULT false NOT NULL;