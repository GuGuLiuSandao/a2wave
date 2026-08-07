PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text NOT NULL,
	`url` text,
	`headers` text,
	`env` text,
	`is_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_mcp_servers`("id", "name", "description", "type", "command", "args", "url", "headers", "env", "is_enabled", "created_at", "updated_at") SELECT "id", "name", "description", "type", "command", "args", "url", "headers", "env", "is_enabled", "created_at", "updated_at" FROM `mcp_servers`;--> statement-breakpoint
DROP TABLE `mcp_servers`;--> statement-breakpoint
ALTER TABLE `__new_mcp_servers` RENAME TO `mcp_servers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;