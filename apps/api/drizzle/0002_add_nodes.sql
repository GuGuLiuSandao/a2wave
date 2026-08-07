CREATE TABLE IF NOT EXISTS `nodes` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `type` text NOT NULL DEFAULT 'local',
  `token_hash` text NOT NULL,
  `status` text NOT NULL DEFAULT 'offline',
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
ALTER TABLE `agents` ADD COLUMN `node_id` text REFERENCES `nodes`(`id`);
