CREATE TABLE `staff_google_identities` (
	`subject` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_authenticated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_google_member_unique` ON `staff_google_identities` (`member_id`);--> statement-breakpoint
CREATE TABLE `staff_oauth_challenges` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`browser_hash` text NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`portal` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "staff_oauth_portal_check" CHECK("staff_oauth_challenges"."portal" IN ('admin', 'teacher'))
);
--> statement-breakpoint
CREATE INDEX `staff_oauth_expiry_idx` ON `staff_oauth_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `staff_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`google_subject` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`google_subject`) REFERENCES `staff_google_identities`(`subject`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `staff_sessions_expiry_idx` ON `staff_sessions` (`expires_at`);