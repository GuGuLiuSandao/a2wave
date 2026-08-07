ALTER TABLE `nodes` ADD `install_token_hash` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `installed` integer DEFAULT 0 NOT NULL;