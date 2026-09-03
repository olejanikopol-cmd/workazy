// Схема Workazy: SQLite (Cloudflare D1) через Drizzle ORM.
// Миграции генерируются командой `npm run db:generate`.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    date: text("date").notNull(),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_tasks_date").on(table.date)],
);

// Самостоятельные задания из Workazy GPT и ручного ввода.
// Они не связаны с пунктами ежедневного плана из таблицы tasks.
export const assignments = sqliteTable(
  "assignments",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: text("due_date"),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_assignments_completed_due_date").on(table.completed, table.dueDate)],
);

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  period: text("period", { enum: ["week", "month", "year"] }).notNull(),
  progress: integer("progress").notNull().default(0),
  deadline: text("deadline").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// body может быть пустой: голосовые и видеозаписи создают запись без текста.
// Пустота сохраняется как NULL; API наружу всегда отдаёт строку (минимум "").
export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    title: text("title"),
    body: text("body"),
    mood: text("mood"),
    tags: text("tags").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_journal_entries_date").on(table.date)],
);

// Медиа дневника: бинарные файлы живут только в R2 (биндинг MEDIA),
// здесь — метаданные, связь с записью и результат расшифровки.
// Одна запись дневника может иметь несколько вложений.
export const journalMedia = sqliteTable(
  "journal_media",
  {
    id: text("id").primaryKey(),
    journalEntryId: text("journal_entry_id").notNull(),
    type: text("type", { enum: ["audio", "video"] }).notNull(),
    storageKey: text("storage_key").notNull(),
    // Отдельная лёгкая аудиодорожка видеозаписи — вход для Whisper и retry.
    // Живёт вместе с оригиналом, чтобы видео никогда не уходило целиком в ASR.
    transcriptionInputKey: text("transcription_input_key"),
    mimeType: text("mime_type").notNull(),
    originalFilename: text("original_filename"),
    sizeBytes: integer("size_bytes").notNull(),
    durationMs: integer("duration_ms"),
    width: integer("width"),
    height: integer("height"),
    transcript: text("transcript"),
    transcriptEdited: integer("transcript_edited", { mode: "boolean" }).notNull().default(false),
    transcriptionStatus: text("transcription_status", { enum: ["pending", "processing", "ready", "error"] }).notNull().default("pending"),
    transcriptionError: text("transcription_error"),
    transcriptionProvider: text("transcription_provider"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_journal_media_entry").on(table.journalEntryId)],
);

export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    date: text("date").notNull(),
    time: text("time"),
    note: text("note"),
    reminder: text("reminder"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_calendar_events_date").on(table.date)],
);

export const ideas = sqliteTable(
  "ideas",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category", { enum: ["thought", "want", "project", "purchase", "someday"] }).notNull(),
    status: text("status", { enum: ["new", "thinking", "plan", "done", "archive"] }).notNull().default("new"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_ideas_status").on(table.status), index("idx_ideas_category").on(table.category)],
);

// Настройки в формате ключ-значение: одна строка на настройку.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// История напоминаний для Telegram-бота.
// Связь с задачами, событиями и финансовыми обязательствами полиморфная:
// по паре (entityType, entityId).
// entityType "digest" + entityId "hourly" — почасовая сводка для анти-спама:
// в payload хранится хэш состава задач/событий, уже отправленных в Telegram.
export const reminderLogs = sqliteTable(
  "reminder_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type", { enum: ["task", "event", "obligation", "digest"] }).notNull(),
    entityId: text("entity_id").notNull(),
    dueAt: text("due_at").notNull(),
    sentAt: text("sent_at"),
    channel: text("channel").notNull().default("telegram"),
    status: text("status", { enum: ["pending", "sent", "skipped", "error"] }).notNull().default("pending"),
    payload: text("payload"),
  },
  (table) => [index("idx_reminder_logs_status_due_at").on(table.status, table.dueAt)],
);
