ALTER TABLE `skills` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
UPDATE `skills`
SET `visibility` = 'all-users'
WHERE `user_id` IS NULL
  AND `name` IN ('a2wave-memory', 'frontend-design');
