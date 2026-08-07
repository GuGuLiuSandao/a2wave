CREATE TABLE `path_locks` (
	`path` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`path_type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
