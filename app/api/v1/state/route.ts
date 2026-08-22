export const dynamic = "force-dynamic";

// Синхронизация сайта:
// GET  /api/v1/state — забрать полное состояние,
// PUT  /api/v1/state — заменить состояние на сервере (одна транзакция).
// Это упрощённая модель для одного пользователя: сервер — источник истины,
// при включении синхронизации сайт сначала забирает состояние с сервера.
import { asc, desc } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/db";
import { calendarEvents, goals, ideas, journalEntries, tasks } from "@/db/schema";
import { entryToJson, eventToJson, goalToJson, ideaToJson, jsonOk, readBool, readInt, readJsonBody, readOneOf, readOptionalText, readOptionalTime, readTags, readText, requireIsoDate, requireOneOf, requireText, taskToJson, ApiError, nowIso, withApi } from "@/lib/api";

const CATEGORIES = ["thought", "want", "project", "purchase", "someday"] as const;
const STATUSES = ["new", "thinking", "plan", "done", "archive"] as const;
const PERIODS = ["week", "month", "year"] as const;

export const GET = withApi(async () => {
  const db = await getDb();
  const [taskRows, goalRows, entryRows, eventRows, ideaRows] = await Promise.all([
    db.select().from(tasks).orderBy(asc(tasks.date), asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(goals).orderBy(asc(goals.createdAt)),
    db.select().from(journalEntries).orderBy(desc(journalEntries.date), desc(journalEntries.createdAt)),
    db.select().from(calendarEvents).orderBy(asc(calendarEvents.date), asc(calendarEvents.time)),
    db.select().from(ideas).orderBy(asc(ideas.createdAt)),
  ]);
  return jsonOk({
    tasks: taskRows.map(taskToJson),
    goals: goalRows.map(goalToJson),
    entries: entryRows.map(entryToJson),
    events: eventRows.map(eventToJson),
    ideas: ideaRows.map(ideaToJson),
  });
});

function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ApiError(400, `Поле «${field}» должно быть массивом`);
  if (value.length > 500) throw new ApiError(400, `Поле «${field}» слишком большое`);
  return value;
}

function readItemObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, `${label} должен быть объектом`);
  return value as Record<string, unknown>;
}

function readTimestamps(item: Record<string, unknown>, label: string): { createdAt: string; updatedAt: string } {
  const now = nowIso();
  return {
    createdAt: readText(item.createdAt, `${label}.createdAt`, { required: false, maxLength: 40 }) ?? now,
    updatedAt: readText(item.updatedAt, `${label}.updatedAt`, { required: false, maxLength: 40 }) ?? now,
  };
}

function parseTaskItem(value: unknown, index: number): typeof tasks.$inferInsert {
  const label = `tasks[${index}]`;
  const item = readItemObject(value, label);
  return {
    id: requireText(item.id, `${label}.id`, { maxLength: 80 }),
    title: requireText(item.title, `${label}.title`, { maxLength: 300 }),
    date: requireIsoDate(item.date, `${label}.date`),
    completed: readBool(item.completed, `${label}.completed`) ?? false,
    position: index,
    ...readTimestamps(item, label),
  };
}

function parseGoalItem(value: unknown, index: number): typeof goals.$inferInsert {
  const label = `goals[${index}]`;
  const item = readItemObject(value, label);
  return {
    id: requireText(item.id, `${label}.id`, { maxLength: 80 }),
    title: requireText(item.title, `${label}.title`, { maxLength: 300 }),
    description: readOptionalText(item.description, `${label}.description`, { maxLength: 1000 }) ?? null,
    period: requireOneOf(item.period, `${label}.period`, PERIODS),
    progress: readInt(item.progress, `${label}.progress`, { min: 0, max: 100 }) ?? 0,
    deadline: requireIsoDate(item.deadline, `${label}.deadline`),
    completed: readBool(item.completed, `${label}.completed`) ?? false,
    ...readTimestamps(item, label),
  };
}

function parseEntryItem(value: unknown, index: number): typeof journalEntries.$inferInsert {
  const label = `entries[${index}]`;
  const item = readItemObject(value, label);
  return {
    id: requireText(item.id, `${label}.id`, { maxLength: 80 }),
    date: requireIsoDate(item.date, `${label}.date`),
    title: readOptionalText(item.title, `${label}.title`, { maxLength: 300 }) ?? null,
    body: requireText(item.body, `${label}.body`, { maxLength: 5000 }),
    mood: readOptionalText(item.mood, `${label}.mood`, { maxLength: 60 }) ?? null,
    tags: JSON.stringify(readTags(item.tags, `${label}.tags`)),
    ...readTimestamps(item, label),
  };
}

function parseEventItem(value: unknown, index: number): typeof calendarEvents.$inferInsert {
  const label = `events[${index}]`;
  const item = readItemObject(value, label);
  return {
    id: requireText(item.id, `${label}.id`, { maxLength: 80 }),
    title: requireText(item.title, `${label}.title`, { maxLength: 300 }),
    date: requireIsoDate(item.date, `${label}.date`),
    time: readOptionalTime(item.time, `${label}.time`) ?? null,
    note: readOptionalText(item.note, `${label}.note`, { maxLength: 1000 }) ?? null,
    reminder: readOptionalText(item.reminder, `${label}.reminder`, { maxLength: 200 }) ?? null,
    ...readTimestamps(item, label),
  };
}

function assertUniqueIds(rows: { id: string }[], field: string) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new ApiError(400, `Поле «${field}» содержит повторяющийся id: ${row.id}`);
    ids.add(row.id);
  }
}

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

function parseIdeaItem(value: unknown, index: number): typeof ideas.$inferInsert {
  const label = `ideas[${index}]`;
  const item = readItemObject(value, label);
  return {
    id: requireText(item.id, `${label}.id`, { maxLength: 80 }),
    title: requireText(item.title, `${label}.title`, { maxLength: 300 }),
    description: readOptionalText(item.description, `${label}.description`, { maxLength: 2000 }) ?? null,
    category: requireOneOf(item.category, `${label}.category`, CATEGORIES),
    status: readOneOf(item.status, `${label}.status`, STATUSES, { required: false }) ?? "new",
    ...readTimestamps(item, label),
  };
}

export const PUT = withApi(async (request) => {
  const body = await readJsonBody(request);
  const taskRows = readArray(body.tasks, "tasks").map(parseTaskItem);
  const goalRows = readArray(body.goals, "goals").map(parseGoalItem);
  const entryRows = readArray(body.entries, "entries").map(parseEntryItem);
  const eventRows = readArray(body.events, "events").map(parseEventItem);
  const ideaRows = readArray(body.ideas, "ideas").map(parseIdeaItem);

  assertUniqueIds(taskRows, "tasks");
  assertUniqueIds(goalRows, "goals");
  assertUniqueIds(entryRows, "entries");
  assertUniqueIds(eventRows, "events");
  assertUniqueIds(ideaRows, "ideas");

  const db = await getDb();
  const statements: BatchItem<"sqlite">[] = [
    db.delete(tasks),
    db.delete(goals),
    db.delete(journalEntries),
    db.delete(calendarEvents),
    db.delete(ideas),
  ];

  // D1 allows at most 100 bound parameters per statement. A batch stays atomic.
  for (const rows of chunks(taskRows, 14)) statements.push(db.insert(tasks).values(rows));
  for (const rows of chunks(goalRows, 11)) statements.push(db.insert(goals).values(rows));
  for (const rows of chunks(entryRows, 12)) statements.push(db.insert(journalEntries).values(rows));
  for (const rows of chunks(eventRows, 12)) statements.push(db.insert(calendarEvents).values(rows));
  for (const rows of chunks(ideaRows, 14)) statements.push(db.insert(ideas).values(rows));

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return jsonOk({
    tasks: taskRows.length,
    goals: goalRows.length,
    entries: entryRows.length,
    events: eventRows.length,
    ideas: ideaRows.length,
  });
});
