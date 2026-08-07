DROP INDEX `users_idaas_sub_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_idaas_identity_unique` ON `users` (`idaas_issuer`,`idaas_sub`);