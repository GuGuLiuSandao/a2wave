ALTER TABLE `scm_sources` ADD `setup_script` text;--> statement-breakpoint
ALTER TABLE `scm_sources` ADD `setup_script_status` text DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE `scm_sources` ADD `setup_script_last_run_at` integer;--> statement-breakpoint
ALTER TABLE `scm_sources` ADD `setup_script_last_error` text;--> statement-breakpoint
ALTER TABLE `scm_sources` ADD `setup_script_last_output` text;