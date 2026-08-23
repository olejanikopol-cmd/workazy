export const CREATE_JOURNAL_MEDIA_SQL = [
  `CREATE TABLE IF NOT EXISTS journal_media (
    id text PRIMARY KEY NOT NULL,
    journal_entry_id text NOT NULL,
    type text NOT NULL,
    storage_key text NOT NULL,
    transcription_input_key text,
    mime_type text NOT NULL,
    original_filename text,
    size_bytes integer NOT NULL,
    duration_ms integer,
    width integer,
    height integer,
    transcript text,
    transcript_edited integer DEFAULT false NOT NULL,
    transcription_status text DEFAULT 'pending' NOT NULL,
    transcription_error text,
    transcription_provider text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_journal_media_entry ON journal_media (journal_entry_id)",
] as const;

// D1 batch выполняет этот набор атомарно. Исходная таблица удаляется только
// после полного копирования; старые текстовые записи сохраняются без изменений.
export const MAKE_JOURNAL_BODY_NULLABLE_SQL = [
  "DROP TABLE IF EXISTS __workazy_journal_entries_0001",
  `CREATE TABLE __workazy_journal_entries_0001 (
    id text PRIMARY KEY NOT NULL,
    date text NOT NULL,
    title text,
    body text,
    mood text,
    tags text DEFAULT '[]' NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
  `INSERT INTO __workazy_journal_entries_0001
    (id, date, title, body, mood, tags, created_at, updated_at)
    SELECT id, date, title, body, mood, tags, created_at, updated_at FROM journal_entries`,
  "DROP TABLE journal_entries",
  "ALTER TABLE __workazy_journal_entries_0001 RENAME TO journal_entries",
  "CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries (date)",
] as const;
