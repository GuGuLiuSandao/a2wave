UPDATE `runs`
SET `trigger_session_id` = `trigger_session_id` || '#duplicate:' || `id`
WHERE `id` IN (
	SELECT `id`
	FROM (
		SELECT
			`id`,
			ROW_NUMBER() OVER (
				PARTITION BY `initiator_agent_id`, `trigger_source`, `trigger_session_id`
				ORDER BY `created_at` DESC, `id` DESC
			) AS `rn`
		FROM `runs`
		WHERE `trigger_source` IN ('api', 'a2a')
			AND `trigger_session_id` IS NOT NULL
			AND `status` IN ('pending', 'queued', 'running', 'completed')
	)
	WHERE `rn` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_idempotency_key_unique` ON `runs` (`initiator_agent_id`,`trigger_source`,`trigger_session_id`) WHERE trigger_source IN ('api', 'a2a') AND trigger_session_id IS NOT NULL AND status IN ('pending', 'queued', 'running', 'completed');
