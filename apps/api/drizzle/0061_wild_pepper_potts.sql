ALTER TABLE `agents` ADD `a2a_auth_type` text DEFAULT 'api_key' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `a2a_endpoint_api_key` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `trust_forwarded_identity` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: 存量 agent 的 A2A 鉴权方式沿用原 REST API 渠道设置；
-- 但 A2A key 全新生成（前缀 a2ak_，不复用旧 ak_ key），调用方需更新为新 key。
UPDATE `agents` SET `a2a_auth_type` = COALESCE(`publish_auth_type`, 'api_key');--> statement-breakpoint
UPDATE `agents` SET `a2a_endpoint_api_key` = 'a2ak_' || lower(hex(randomblob(18))) WHERE `a2a_endpoint_api_key` IS NULL;--> statement-breakpoint
-- Backfill trust_forwarded_identity：为「网关接入 + A2A 已发布」的存量 agent 置 1，
-- 让它们在新闸门下尽量保留既有的身份透传行为（否则默认 false 会让其报
-- GATEWAY_NO_USER_IDENTITY）。
-- 注意（intended security fix）：新闸门额外要求本 hop 鉴权为 api_key。对于
-- 「REST 公开（auth=none）+ A2A 已发布 + 网关」这一**子集**，上一条已把
-- a2a_auth_type backfill 成 none，故即便此处置 trust=1，运行时闸门仍会拒绝透传
-- —— 这是有意收紧：开放(无密钥)的 A2A 端点 + 身份透传 = 任何人可伪造身份签网关
-- token。这类 agent 需改用 a2a_auth_type=api_key（发新 a2ak_ key）才能恢复透传。
UPDATE `agents` SET `trust_forwarded_identity` = 1 WHERE `gateway_enabled` = 1 AND `publish_channels` LIKE '%a2a%';
