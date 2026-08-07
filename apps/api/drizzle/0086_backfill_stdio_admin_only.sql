-- Backfill: stdio MCP servers are host-command executors and must be admin-only.
-- Pre-existing rows may be admin_only=0; pin them to 1 so a non-admin can no
-- longer bind them to an agent (the binding check and runtime keyed off this).
-- Group servers with inline stdio backends are covered at bind-time by the
-- introducesStdioExecution runtime check (JSON groupConfig isn't parsed here).
UPDATE `mcp_servers` SET `admin_only` = 1 WHERE `type` = 'stdio' AND `admin_only` = 0;
