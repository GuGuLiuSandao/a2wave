CREATE TABLE `evaluation_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`set_id` text NOT NULL,
	`name` text NOT NULL,
	`turns` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`set_id`) REFERENCES `evaluation_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluation_cases_set_id_idx` ON `evaluation_cases` (`set_id`);--> statement-breakpoint
CREATE INDEX `evaluation_cases_set_sort_idx` ON `evaluation_cases` (`set_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `evaluation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`case_id` text,
	`case_name` text NOT NULL,
	`turns_snapshot` text NOT NULL,
	`actual_turns` text,
	`review` text,
	`score` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`duration_ms` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `evaluation_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `evaluation_cases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evaluation_results_task_id_idx` ON `evaluation_results` (`task_id`);--> statement-breakpoint
CREATE INDEX `evaluation_results_task_sort_idx` ON `evaluation_results` (`task_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `evaluation_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evaluation_sets_agent_id_idx` ON `evaluation_sets` (`agent_id`);--> statement-breakpoint
CREATE TABLE `evaluation_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`set_id` text,
	`set_name` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`config_snapshot` text NOT NULL,
	`summary` text,
	`error` text,
	`user_id` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_id`) REFERENCES `evaluation_sets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evaluation_tasks_agent_id_created_at_idx` ON `evaluation_tasks` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evaluation_tasks_status_idx` ON `evaluation_tasks` (`status`);