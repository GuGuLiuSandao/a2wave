ALTER TABLE `agents` ADD `provider_api_key` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `endpoint_api_key` text;--> statement-breakpoint
UPDATE agents SET endpoint_api_key = api_key WHERE api_key LIKE 'ak_%';--> statement-breakpoint
UPDATE agents SET provider_api_key = api_key WHERE api_key NOT LIKE 'ak_%' AND api_key IS NOT NULL;
