ALTER TABLE `providers` ADD `enabled_models` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
-- Initialize enabled_models = models for existing providers
UPDATE `providers` SET `enabled_models` = `models` WHERE `enabled_models` = '[]' AND `models` != '[]';
