DROP INDEX `assignments_student_date_slot_unique`;--> statement-breakpoint
ALTER TABLE `reflection_assignments` ADD `rescheduled_from_id` text REFERENCES reflection_assignments(id);--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_source_active_unique` ON `reflection_assignments` (`rescheduled_from_id`) WHERE "reflection_assignments"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_student_date_slot_unique` ON `reflection_assignments` (`student_id`,`date`,`slot`) WHERE "reflection_assignments"."cancelled_at" IS NULL;