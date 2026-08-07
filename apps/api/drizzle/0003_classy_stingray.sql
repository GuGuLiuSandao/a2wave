CREATE TABLE IF NOT EXISTS `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'local' NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`host` text,
	`work_dir` text,
	`config` text,
	`labels` text,
	`version` text,
	`last_heartbeat` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'cursor' NOT NULL,
	`config` text,
	`status` text DEFAULT 'active' NOT NULL,
	`icon` text DEFAULT '🤖' NOT NULL,
	`system_prompt` text,
	`skills` text NOT NULL,
	`publish_status` text DEFAULT 'draft' NOT NULL,
	`api_key` text,
	`node_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "description", "type", "config", "status", "icon", "system_prompt", "skills", "publish_status", "api_key", "node_id", "created_at", "updated_at") SELECT "id", "name", "description", "type", "config", "status", "icon", "system_prompt", "skills", "publish_status", "api_key", "node_id", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;