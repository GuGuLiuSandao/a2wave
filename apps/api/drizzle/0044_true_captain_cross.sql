ALTER TABLE `agents` ADD `kb_document_ids` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `kb_documents` ADD `auto_sync` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `kb_documents` ADD `sync_interval_min` integer DEFAULT 60 NOT NULL;