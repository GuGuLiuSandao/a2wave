-- Replace the old `admin_only` boolean with the three-state `usage_scope`.
-- The column is added with the schema default 'private' (so the snapshot and the
-- live table agree), then every existing row is explicitly backfilled to its final
-- three-state value from `admin_only` + type + ownership, and finally `admin_only`
-- is dropped. Order matters: the two 'admin-only' UPDATEs run BEFORE the ownership
-- split so a stdio row can never fall through to 'private'/'all-users'.
--
-- Target semantics:
--   * stdio-capable (top-level stdio, or a group whose config contains ANY backend
--     of type 'stdio') → 'admin-only' (host RCE).
--   * any admin_only=1 row → 'admin-only' (already restricted).
--   * a non-stdio admin_only=0 row:
--       - owned by an ADMIN, or a system builtin (user_id IS NULL) → 'all-users'
--         (a deliberate org share stays shared),
--       - owned by a NON-ADMIN → 'private' (owner-only; its URL/headers/env are
--         private credentials and must NOT leak to everyone — the security fix the
--         three-state model exists for). This is also the added-column default, so
--         non-admin rows need no explicit UPDATE.
--
-- Group stdio detection uses json_tree (whitespace/format-independent, unlike a
-- text LIKE): a NULL/invalid group_config is treated as NOT provably stdio-free, so
-- an admin_only=1 group is caught by the admin_only rule and an admin_only=0 group
-- with unparseable config stays at the fail-closed 'private' default.
ALTER TABLE `mcp_servers` ADD `usage_scope` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
-- stdio-capable rows → 'admin-only' (top-level stdio, or a group with any stdio backend).
UPDATE `mcp_servers` SET `usage_scope` = 'admin-only' WHERE `type` = 'stdio';--> statement-breakpoint
UPDATE `mcp_servers` SET `usage_scope` = 'admin-only'
  WHERE `type` = 'group' AND `group_config` IS NOT NULL AND json_valid(`group_config`)
    AND EXISTS (
      SELECT 1 FROM json_tree(`group_config`)
      WHERE json_tree.key = 'type' AND json_tree.value = 'stdio'
    );--> statement-breakpoint
-- Any explicitly restricted row → 'admin-only'.
UPDATE `mcp_servers` SET `usage_scope` = 'admin-only' WHERE `admin_only` = 1;--> statement-breakpoint
-- Remaining non-stdio, non-restricted rows owned by an admin or a builtin → 'all-users'
-- (a deliberate org share). Non-admin-owned rows keep the fail-closed 'private' default.
UPDATE `mcp_servers` SET `usage_scope` = 'all-users'
  WHERE `usage_scope` = 'private'
    AND (`user_id` IS NULL OR `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'admin'));--> statement-breakpoint
ALTER TABLE `mcp_servers` DROP COLUMN `admin_only`;
