CREATE TABLE `app_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`linked_user_id` text,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	CONSTRAINT "app_users_role_check" CHECK("app_users"."role" IN ('admin', 'teacher')),
	CONSTRAINT "app_users_status_check" CHECK("app_users"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_users_email_unique` ON `app_users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_users_linked_user_unique` ON `app_users` (`linked_user_id`);--> statement-breakpoint
ALTER TABLE `reflection_assignments` ADD `attendance_recorded_by` text;--> statement-breakpoint
ALTER TABLE `reflection_assignments` ADD `attendance_recorded_at` text;--> statement-breakpoint
ALTER TABLE `students` ADD `active` integer DEFAULT true NOT NULL;