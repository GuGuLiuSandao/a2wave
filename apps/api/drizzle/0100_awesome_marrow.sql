-- Hand-written rather than the generated table rebuild.
--
-- drizzle emits a full CREATE __new_agents / INSERT SELECT / DROP TABLE agents / RENAME for a
-- default-value change. That is unsafe here: `PRAGMA foreign_keys=OFF` is a no-op inside the
-- BEGIN…COMMIT drizzle wraps a migration in, and db/client.ts connects with `foreign_keys = ON`,
-- so `DROP TABLE agents` runs with foreign keys live. It either aborts the upgrade on a NO ACTION
-- child row (run_steps / artifacts / runs.initiator_agent_id) or — worse — reports success while
-- CASCADE silently empties agent_members, evaluation_sets, evaluation_tasks and the feishu_*
-- tables. Both were reproduced on real SQLite.
--
-- This change needs no rebuild: one added column, one default change, one value translation.
-- The default only governs future INSERTs, and every INSERT goes through Drizzle with the column
-- supplied, so leaving the old column default in place costs nothing and avoids the rebuild.
ALTER TABLE `agents` ADD `oauth_allowed_emails` text;--> statement-breakpoint
-- The retired `feishu_scope` mode collapses to `specified_users` with a NULL (empty) allowlist —
-- fail-closed. Widening it to `all_idaas_users` would use an upgrade to silently open an Agent
-- that was deliberately restricted.
--
-- Scoped to Agents that actually publish the `oauth` channel. `feishu_scope` was this column's
-- DEFAULT (migration 0071), so it also marks every Agent that never touched the setting; treating
-- those as "deliberately restricted" would strand the entire existing estate in
-- `specified_users` + empty list and make the new `all_idaas_users` default unreachable for any
-- row that already exists. Everything else lands on the new default.
UPDATE `agents` SET `oauth_access_mode` = CASE
  WHEN `publish_channels` LIKE '%"oauth"%' THEN 'specified_users'
  ELSE 'all_idaas_users'
END WHERE `oauth_access_mode` = 'feishu_scope';
