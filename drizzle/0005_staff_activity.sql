CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`target_name` text NOT NULL,
	`details` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_events_created_idx` ON `activity_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `app_users` ADD `deleted_at` text;