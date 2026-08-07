CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'llm' NOT NULL,
	`config` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wave_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`wave_id` text NOT NULL,
	`agent_id` text,
	`order` integer NOT NULL,
	`input` text,
	`output` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`wave_id`) REFERENCES `waves`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `waves` (
	`id` text PRIMARY KEY NOT NULL,
	`intent` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`initiator_agent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`initiator_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
