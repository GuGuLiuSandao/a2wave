CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text NOT NULL,
	`url` text,
	`headers` text,
	`env` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`content` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
DROP TABLE IF EXISTS `nodes`;--> statement-breakpoint
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
	`mcp_server_ids` text NOT NULL,
	`publish_status` text DEFAULT 'draft' NOT NULL,
	`api_key` text,
	`provider_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "name", "description", "type", "config", "status", "icon", "system_prompt", "skills", "mcp_server_ids", "publish_status", "api_key", "provider_id", "created_at", "updated_at") SELECT "id", "name", "description", "type", "config", "status", "icon", "system_prompt", "skills", '[]', "publish_status", "api_key", "provider_id", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_preset` integer DEFAULT false NOT NULL,
	`os_requirement` text DEFAULT 'any' NOT NULL,
	`init_script` text,
	`check_script` text,
	`runtime` text,
	`entrypoint` text,
	`models` text NOT NULL,
	`enabled_models` text NOT NULL,
	`config` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_providers`("id", "name", "description", "is_preset", "os_requirement", "init_script", "check_script", "runtime", "entrypoint", "models", "enabled_models", "config", "created_at", "updated_at") SELECT "id", "name", "description", "is_preset", "os_requirement", "init_script", "check_script", "runtime", "entrypoint", "models", "enabled_models", "config", "created_at", "updated_at" FROM `providers`;--> statement-breakpoint
DROP TABLE `providers`;--> statement-breakpoint
ALTER TABLE `__new_providers` RENAME TO `providers`;