CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`due_date` text,
	`completed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assignments_completed_due_date` ON `assignments` (`completed`,`due_date`);