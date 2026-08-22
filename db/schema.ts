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

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    mood: text("mood"),
    tags: text("tags").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_journal_entries_date").on(table.date)],
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
// Связь с задачами/событиями полиморфная: по паре (entityType, entityId).
// entityType "digest" + entityId "hourly" — почасовая сводка для анти-спама:
// в payload хранится хэш состава задач/событий, уже отправленных в Telegram.
export const reminderLogs = sqliteTable(
  "reminder_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type", { enum: ["task", "event", "digest"] }).notNull(),
    entityId: text("entity_id").notNull(),
    dueAt: text("due_at").notNull(),
    sentAt: text("sent_at"),
    channel: text("channel").notNull().default("telegram"),
    status: text("status", { enum: ["pending", "sent", "skipped", "error"] }).notNull().default("pending"),
    payload: text("payload"),
  },
  (table) => [index("idx_reminder_logs_status_due_at").on(table.status, table.dueAt)],
);
