-- Run through libSQL client.migrate(): it disables foreign keys before its
-- atomic transaction and restores enforcement after either commit or rollback.
-- Plain execution with foreign keys enabled is rejected before rebuilding.
CREATE TEMP TABLE `__moderator_migration_guard` (`passed` integer NOT NULL CHECK (`passed` = 1));
--> statement-breakpoint
INSERT INTO `__moderator_migration_guard` SELECT CASE WHEN `foreign_keys` = 0 THEN 1 ELSE 0 END FROM pragma_foreign_keys;
--> statement-breakpoint
CREATE TEMP TABLE `__moderator_users_before` AS SELECT "id", "email", "name", "role", "status", "linked_user_id", "created_at", "last_seen_at", "deleted_at" FROM `app_users`;
--> statement-breakpoint
CREATE TEMP TABLE `__moderator_oauth_before` AS SELECT "state_hash", "browser_hash", "nonce", "code_verifier", "portal", "created_at", "expires_at" FROM `staff_oauth_challenges`;
--> statement-breakpoint
CREATE TEMP TABLE `__moderator_identities_before` AS SELECT "subject", "member_id", "email", "created_at", "last_authenticated_at" FROM `staff_google_identities`;
--> statement-breakpoint
CREATE TEMP TABLE `__moderator_sessions_before` AS SELECT "token_hash", "member_id", "google_subject", "created_at", "expires_at" FROM `staff_sessions`;
--> statement-breakpoint
CREATE TABLE `__new_app_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`linked_user_id` text,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	`deleted_at` text,
	CONSTRAINT "app_users_role_check" CHECK("__new_app_users"."role" IN ('admin', 'teacher', 'moderator')),
	CONSTRAINT "app_users_status_check" CHECK("__new_app_users"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
INSERT INTO `__new_app_users`("id", "email", "name", "role", "status", "linked_user_id", "created_at", "last_seen_at", "deleted_at") SELECT "id", "email", "name", "role", "status", "linked_user_id", "created_at", "last_seen_at", "deleted_at" FROM `app_users`;--> statement-breakpoint
DROP TABLE `app_users`;--> statement-breakpoint
ALTER TABLE `__new_app_users` RENAME TO `app_users`;--> statement-breakpoint
CREATE UNIQUE INDEX `app_users_email_unique` ON `app_users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_users_linked_user_unique` ON `app_users` (`linked_user_id`);--> statement-breakpoint
CREATE TABLE `__new_staff_oauth_challenges` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`browser_hash` text NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`portal` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "staff_oauth_portal_check" CHECK("__new_staff_oauth_challenges"."portal" IN ('admin', 'teacher', 'moderator'))
);
--> statement-breakpoint
INSERT INTO `__new_staff_oauth_challenges`("state_hash", "browser_hash", "nonce", "code_verifier", "portal", "created_at", "expires_at") SELECT "state_hash", "browser_hash", "nonce", "code_verifier", "portal", "created_at", "expires_at" FROM `staff_oauth_challenges`;--> statement-breakpoint
DROP TABLE `staff_oauth_challenges`;--> statement-breakpoint
ALTER TABLE `__new_staff_oauth_challenges` RENAME TO `staff_oauth_challenges`;--> statement-breakpoint
CREATE INDEX `staff_oauth_expiry_idx` ON `staff_oauth_challenges` (`expires_at`);
--> statement-breakpoint
INSERT INTO `__moderator_migration_guard`
SELECT CASE WHEN
  (SELECT COUNT(*) FROM `app_users`) = (SELECT COUNT(*) FROM `__moderator_users_before`)
  AND NOT EXISTS (SELECT "id", "email", "name", "role", "status", "linked_user_id", "created_at", "last_seen_at", "deleted_at" FROM `app_users` EXCEPT SELECT "id", "email", "name", "role", "status", "linked_user_id", "created_at", "last_seen_at", "deleted_at" FROM `__moderator_users_before`)
  AND NOT EXISTS (SELECT "id", "email", "name", "role", "status", "linked_user_id", "created_at", "last_seen_at", "deleted_at" FROM `__moderator_users_before` EXCEPT SELECT "id", "email", "name", "role", "status", "linked_user_id", "created_at", "last_seen_at", "deleted_at" FROM `app_users`)
THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO `__moderator_migration_guard`
SELECT CASE WHEN
  (SELECT COUNT(*) FROM `staff_oauth_challenges`) = (SELECT COUNT(*) FROM `__moderator_oauth_before`)
  AND NOT EXISTS (SELECT "state_hash", "browser_hash", "nonce", "code_verifier", "portal", "created_at", "expires_at" FROM `staff_oauth_challenges` EXCEPT SELECT "state_hash", "browser_hash", "nonce", "code_verifier", "portal", "created_at", "expires_at" FROM `__moderator_oauth_before`)
  AND NOT EXISTS (SELECT "state_hash", "browser_hash", "nonce", "code_verifier", "portal", "created_at", "expires_at" FROM `__moderator_oauth_before` EXCEPT SELECT "state_hash", "browser_hash", "nonce", "code_verifier", "portal", "created_at", "expires_at" FROM `staff_oauth_challenges`)
THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO `__moderator_migration_guard`
SELECT CASE WHEN
  (SELECT COUNT(*) FROM `staff_google_identities`) = (SELECT COUNT(*) FROM `__moderator_identities_before`)
  AND NOT EXISTS (SELECT "subject", "member_id", "email", "created_at", "last_authenticated_at" FROM `staff_google_identities` EXCEPT SELECT "subject", "member_id", "email", "created_at", "last_authenticated_at" FROM `__moderator_identities_before`)
  AND NOT EXISTS (SELECT "subject", "member_id", "email", "created_at", "last_authenticated_at" FROM `__moderator_identities_before` EXCEPT SELECT "subject", "member_id", "email", "created_at", "last_authenticated_at" FROM `staff_google_identities`)
THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO `__moderator_migration_guard`
SELECT CASE WHEN
  (SELECT COUNT(*) FROM `staff_sessions`) = (SELECT COUNT(*) FROM `__moderator_sessions_before`)
  AND NOT EXISTS (SELECT "token_hash", "member_id", "google_subject", "created_at", "expires_at" FROM `staff_sessions` EXCEPT SELECT "token_hash", "member_id", "google_subject", "created_at", "expires_at" FROM `__moderator_sessions_before`)
  AND NOT EXISTS (SELECT "token_hash", "member_id", "google_subject", "created_at", "expires_at" FROM `__moderator_sessions_before` EXCEPT SELECT "token_hash", "member_id", "google_subject", "created_at", "expires_at" FROM `staff_sessions`)
THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO `__moderator_migration_guard` SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
--> statement-breakpoint
DROP TABLE `__moderator_users_before`;
--> statement-breakpoint
DROP TABLE `__moderator_oauth_before`;
--> statement-breakpoint
DROP TABLE `__moderator_identities_before`;
--> statement-breakpoint
DROP TABLE `__moderator_sessions_before`;
--> statement-breakpoint
DROP TABLE `__moderator_migration_guard`;
