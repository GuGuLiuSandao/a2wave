-- Clear provider_id on agents that reference non-preset providers
UPDATE `agents` SET `provider_id` = NULL, `updated_at` = (cast(strftime('%s','now') as integer) * 1000) WHERE `provider_id` IN (SELECT `id` FROM `providers` WHERE `is_preset` = 0);
--> statement-breakpoint
-- Delete non-preset (custom) providers
DELETE FROM `providers` WHERE `is_preset` = 0;
