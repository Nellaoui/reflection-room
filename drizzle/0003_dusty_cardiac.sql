ALTER TABLE `students` ADD `toddle_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `students_toddle_id_unique` ON `students` (`toddle_id`);