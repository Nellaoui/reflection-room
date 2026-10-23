CREATE TABLE `reflection_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`assigned_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`cancelled_at` text,
	`cancelled_by_user_id` text,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assignments_slot_check" CHECK("reflection_assignments"."slot" IN ('morning', 'lunch')),
	CONSTRAINT "assignments_status_check" CHECK("reflection_assignments"."status" IN ('pending', 'present', 'absent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_student_date_slot_unique` ON `reflection_assignments` (`student_id`,`date`,`slot`);--> statement-breakpoint
CREATE INDEX `assignments_date_idx` ON `reflection_assignments` (`date`);--> statement-breakpoint
CREATE TABLE `roster_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`imported_at` text NOT NULL,
	`imported_count` integer NOT NULL,
	`imported_by_user_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`grade` text NOT NULL,
	`class_name` text NOT NULL,
	`roster_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_roster_key_unique` ON `students` (`roster_key`);--> statement-breakpoint
CREATE INDEX `students_grade_class_idx` ON `students` (`grade`,`class_name`);