ALTER TABLE `providers` ADD `mcp_config_path` text;
--> statement-breakpoint
ALTER TABLE `agents` ADD `provider_base_url` text;
