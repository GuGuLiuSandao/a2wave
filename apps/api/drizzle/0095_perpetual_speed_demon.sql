ALTER TABLE `agents` DROP COLUMN `gateway_enabled`;--> statement-breakpoint
-- Drop the gateway JWT signing settings, including the encrypted signing key.
DELETE FROM `settings` WHERE `category` = 'jwtSigner';--> statement-breakpoint
-- Drop the removed jwt-redirect SSO login config (OIDC / SAML rows are kept).
DELETE FROM `settings` WHERE `category` = 'sso' AND `key` = 'jwtRedirectConfig';
