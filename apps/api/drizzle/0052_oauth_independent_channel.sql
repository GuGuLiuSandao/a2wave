-- Migration 0052: OAuth 升级为独立发布渠道
--
-- 将 publish_auth_type = 'oauth' 的 agent 迁移到新的独立渠道模型：
--   1. 在 publish_channels JSON 数组中添加 'oauth'
--      - publish_channels IS NULL → 初始化为 '["oauth"]'
--      - publish_channels 已是数组但不含 'oauth' → json_insert 追加
--      - publish_channels 已含 'oauth' → 保持不变（幂等）
--   2. 将 publish_auth_type 重置为 'api_key'（api 渠道继续正常工作）
--
-- 注意：SQLite 的 text 列枚举约束由 ORM 层（Drizzle）在应用侧强制执行，
-- 不在数据库层面使用 CHECK 约束，因此无需 ALTER TABLE。

UPDATE agents
SET
  publish_channels = (
    CASE
      WHEN publish_channels IS NULL
      THEN '["oauth"]'
      WHEN json_type(publish_channels) = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(publish_channels) WHERE value = 'oauth'
        )
      THEN json_insert(publish_channels, '$[#]', 'oauth')
      ELSE publish_channels
    END
  ),
  publish_auth_type = 'api_key',
  updated_at = unixepoch()
WHERE publish_auth_type = 'oauth';
