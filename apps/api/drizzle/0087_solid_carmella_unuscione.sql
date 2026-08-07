DROP INDEX `run_steps_run_id_idx`;--> statement-breakpoint
CREATE INDEX `run_steps_run_id_created_at_idx` ON `run_steps` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `run_steps_created_at_idx` ON `run_steps` (`created_at`);--> statement-breakpoint
ALTER TABLE `runs` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_write_tokens` integer;