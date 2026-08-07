ALTER TABLE `runs` ADD `work_dir` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `worktree_config` text;--> statement-breakpoint
ALTER TABLE `scm_sources` ADD `workspaces_path` text;--> statement-breakpoint
CREATE UNIQUE INDEX `scm_sources_workspaces_path_unique` ON `scm_sources` (`workspaces_path`);