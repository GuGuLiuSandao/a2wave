ALTER TABLE `agents` ADD `memory_provider_api_key` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `embedding_api_key` text;--> statement-breakpoint
UPDATE agents SET memory_provider_api_key = json_extract(config, '$.memoryProviderApiKey')
  WHERE json_extract(config, '$.memoryProviderApiKey') IS NOT NULL;--> statement-breakpoint
UPDATE agents SET embedding_api_key = json_extract(config, '$.embeddingApiKey')
  WHERE json_extract(config, '$.embeddingApiKey') IS NOT NULL;--> statement-breakpoint
UPDATE agents SET config = json_remove(config, '$.memoryProviderApiKey')
  WHERE json_extract(config, '$.memoryProviderApiKey') IS NOT NULL;--> statement-breakpoint
UPDATE agents SET config = json_remove(config, '$.embeddingApiKey')
  WHERE json_extract(config, '$.embeddingApiKey') IS NOT NULL;
