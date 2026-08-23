CREATE TABLE IF NOT EXISTS `journal_media` (
	`id` text PRIMARY KEY NOT NULL,
	`journal_entry_id` text NOT NULL,
	`type` text NOT NULL,
	`storage_key` text NOT NULL,
	`transcription_input_key` text,
	`mime_type` text NOT NULL,
	`original_filename` text,
	`size_bytes` integer NOT NULL,
	`duration_ms` integer,
	`width` integer,
	`height` integer,
	`transcript` text,
	`transcript_edited` integer DEFAULT false NOT NULL,
	`transcription_status` text DEFAULT 'pending' NOT NULL,
	`transcription_error` text,
	`transcription_provider` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_journal_media_entry` ON `journal_media` (`journal_entry_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_journal_entries`;--> statement-breakpoint
CREATE TABLE `__new_journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`title` text,
	`body` text,
	`mood` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_journal_entries`("id", "date", "title", "body", "mood", "tags", "created_at", "updated_at") SELECT "id", "date", "title", "body", "mood", "tags", "created_at", "updated_at" FROM `journal_entries`;--> statement-breakpoint
DROP TABLE `journal_entries`;--> statement-breakpoint
ALTER TABLE `__new_journal_entries` RENAME TO `journal_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_journal_entries_date` ON `journal_entries` (`date`);
