-- Unbind agents that reference Gemini CLI provider
UPDATE `agents` SET `provider_id` = NULL, `updated_at` = (cast(strftime('%s','now') as integer) * 1000) WHERE `provider_id` IN (SELECT `id` FROM `providers` WHERE `name` = 'Gemini CLI');
--> statement-breakpoint
-- Delete Gemini CLI provider
DELETE FROM `providers` WHERE `name` = 'Gemini CLI';
