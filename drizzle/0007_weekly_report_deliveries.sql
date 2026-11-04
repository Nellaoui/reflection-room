CREATE TABLE `weekly_report_deliveries` (
	`week_key` text PRIMARY KEY NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`status` text NOT NULL,
	`attempt_token` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`provider_message_id` text,
	`error_code` text,
	CONSTRAINT "weekly_report_status_check" CHECK("weekly_report_deliveries"."status" IN ('sending', 'sent', 'retryable', 'uncertain')),
	CONSTRAINT "weekly_report_attempts_check" CHECK("weekly_report_deliveries"."attempts" > 0)
);
