CREATE TABLE `git_trigger_states` (
	`agent_id` text NOT NULL,
	`channel` text NOT NULL,
	`repo_key` text NOT NULL,
	`state` text NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `channel`, `repo_key`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `glab_config` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `gh_config` text;