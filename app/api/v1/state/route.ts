export const dynamic = "force-dynamic";

// Синхронизация сайта:
// GET  /api/v1/state — забрать полное состояние,
// PUT  /api/v1/state — заменить состояние на сервере (одна транзакция).
// Это упрощённая модель для одного пользователя: сервер — источник истины,
// при включении синхронизации сайт сначала забирает состояние с сервера.
import { asc, desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/db";
import { assignments, calendarEvents, goals, ideas, journalEntries, settings, tasks } from "@/db/schema";
import { assignmentToJson, entryToJson, eventToJson, goalToJson, ideaToJson, jsonOk, readBool, readInt, readIsoDate, readIsoDateTime, readJsonBody, readOneOf, readOptionalText, readOptionalTime, readTags, readText, requireIsoDate, requireOneOf, requireText, taskToJson, ApiError, nowIso, withApi } from "@/lib/api";
import { attachEntryMedia, listAllMedia, pruneOrphanedMedia } from "@/lib/journal-media";
import { ensureMediaStorageReady } from "@/lib/storage-health";
import { backfillLegacyChatGptAssignment } from "@/lib/legacy-assignments";
import { emptyFinanceState, FINANCE_STATE_KEY, normalizeFinanceState, roundMoney } from "@/lib/finance";
import type { FinanceExpense, FinanceObligation, FinanceState, SalarySchedule } from "@/lib/types";

const CATEGORIES = ["thought", "want", "project", "purchase", "someday"] as const;
const STATUSES = ["new", "thinking", "plan", "done", "archive"] as const;
const PERIODS = ["week", "month", "year"] as const;
const SYNC_STATE_KEY = "planner-sync-updated-at";

function storedFinance(value: string | undefined): FinanceState {
  if (!value) return emptyFinanceState();
  try {
    return normalizeFinanceState(JSON.parse(value));
  } catch {
    return emptyFinanceState();
  }
}

export const GET = withApi(async () => {
  await ensureMediaStorageReady({ requireMedia: false });
  const db = await getDb();
  await backfillLegacyChatGptAssignment(db);
  const [taskRows, assignmentRows, goalRows, entryRows, eventRows, ideaRows, syncRows, financeRows] = await Promise.all([
    db.select().from(tasks).orderBy(asc(tasks.date), asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(assignments).orderBy(asc(assignments.completed), asc(assignments.dueDate), desc(assignments.createdAt)),
    db.select().from(goals).orderBy(asc(goals.createdAt)),
    db.select().from(journalEntries).orderBy(desc(journalEntries.date), desc(journalEntries.createdAt)),
    db.select().from(calendarEvents).orderBy(asc(calendarEvents.date), asc(calendarEvents.time)),
    db.select().from(ideas).orderBy(asc(ideas.createdAt)),
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, SYNC_STATE_KEY)).limit(1),
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, FINANCE_STATE_KEY)).limit(1),
  ]);
  const mediaByEntry = await listAllMedia(db);
  return jsonOk({
    tasks: taskRows.map(taskToJson),
    assignments: assignmentRows.map(assignmentToJson),
    goals: goalRows.map(goalToJson),
    entries: attachEntryMedia(entryRows.map(entryToJson), mediaByEntry),
    events: eventRows.map(eventToJson),
    ideas: ideaRows.map(ideaToJson),
    finances: storedFinance(financeRows[0]?.value),
    syncUpdatedAt: syncRows[0]?.value,
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

function parseAssignmentItem(value: unknown, index: number): typeof assignments.$inferInsert {
  const label = `assignments[${index}]`;
  const item = readItemObject(value, label);
  return {
    id: requireText(item.id, `${label}.id`, { maxLength: 80 }),
    title: requireText(item.title, `${label}.title`, { maxLength: 300 }),
    description: readOptionalText(item.description, `${label}.description`, { maxLength: 2000 }) ?? null,
    dueDate: readIsoDate(item.dueDate, `${label}.dueDate`, { required: false }) ?? null,
    completed: readBool(item.completed, `${label}.completed`) ?? false,
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
    // Текст может быть пустым у записей из аудио/видео.
    body: readOptionalText(item.body, `${label}.body`, { maxLength: 5000 }) ?? null,
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

function readMoney(value: unknown, field: string, { allowZero = true }: { allowZero?: boolean } = {}): number {
  const minimum = allowZero ? 0 : Number.EPSILON;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > 1_000_000_000) {
    throw new ApiError(400, `Поле «${field}» должно быть корректной суммой`);
  }
  return roundMoney(value);
}

function parseFinanceState(value: unknown): FinanceState {
  const item = readItemObject(value, "finances");
  const salarySchedules = readArray(item.salarySchedules, "finances.salarySchedules").map((raw, index): SalarySchedule => {
    const label = `finances.salarySchedules[${index}]`;
    const schedule = readItemObject(raw, label);
    const dayOfMonth = readInt(schedule.dayOfMonth, `${label}.dayOfMonth`, { min: 1, max: 31 });
    if (dayOfMonth === undefined) throw new ApiError(400, `Поле «${label}.dayOfMonth» обязательно`);
    const timestamps = readTimestamps(schedule, label);
    return {
      id: requireText(schedule.id, `${label}.id`, { maxLength: 80 }),
      dayOfMonth,
      amount: readMoney(schedule.amount, `${label}.amount`),
      title: requireText(schedule.title, `${label}.title`, { maxLength: 120 }),
      ...timestamps,
    };
  });
  const expenses = readArray(item.expenses, "finances.expenses").map((raw, index): FinanceExpense => {
    const label = `finances.expenses[${index}]`;
    const expense = readItemObject(raw, label);
    return {
      id: requireText(expense.id, `${label}.id`, { maxLength: 80 }),
      date: requireIsoDate(expense.date, `${label}.date`),
      amount: readMoney(expense.amount, `${label}.amount`, { allowZero: false }),
      note: readOptionalText(expense.note, `${label}.note`, { maxLength: 300 }) ?? undefined,
      createdAt: readText(expense.createdAt, `${label}.createdAt`, { required: false, maxLength: 40 }) ?? nowIso(),
    };
  });
  const obligations = (item.obligations === undefined ? [] : readArray(item.obligations, "finances.obligations")).map((raw, index): FinanceObligation => {
    const label = `finances.obligations[${index}]`;
    const obligation = readItemObject(raw, label);
    const timestamps = readTimestamps(obligation, label);
    return {
      id: requireText(obligation.id, `${label}.id`, { maxLength: 80 }),
      kind: requireOneOf(obligation.kind, `${label}.kind`, ["debt", "purchase"] as const),
      title: requireText(obligation.title, `${label}.title`, { maxLength: 200 }),
      amount: readMoney(obligation.amount, `${label}.amount`, { allowZero: false }),
      dueDate: readIsoDate(obligation.dueDate, `${label}.dueDate`, { required: false }),
      reminderTime: readOptionalTime(obligation.reminderTime, `${label}.reminderTime`) ?? undefined,
      completed: readBool(obligation.completed, `${label}.completed`) ?? false,
      ...timestamps,
    };
  });
  assertUniqueIds(salarySchedules, "finances.salarySchedules");
  assertUniqueIds(expenses, "finances.expenses");
  assertUniqueIds(obligations, "finances.obligations");
  return {
    balance: readMoney(item.balance, "finances.balance"),
    salarySchedules,
    expenses,
    obligations,
    updatedAt: readText(item.updatedAt, "finances.updatedAt", { required: false, maxLength: 40 }),
  };
}

export const PUT = withApi(async (request) => {
  await ensureMediaStorageReady({ requireMedia: false });
  const body = await readJsonBody(request);
  const clientUpdatedAt = readIsoDateTime(body.syncUpdatedAt, "syncUpdatedAt", { required: false }) ?? nowIso();
  const taskRows = readArray(body.tasks, "tasks").map(parseTaskItem);
  const assignmentRows = body.assignments === undefined ? null : readArray(body.assignments, "assignments").map(parseAssignmentItem);
  const goalRows = readArray(body.goals, "goals").map(parseGoalItem);
  const entryRows = readArray(body.entries, "entries").map(parseEntryItem);
  const eventRows = readArray(body.events, "events").map(parseEventItem);
  const ideaRows = readArray(body.ideas, "ideas").map(parseIdeaItem);
  const financeState = body.finances === undefined ? null : parseFinanceState(body.finances);

  assertUniqueIds(taskRows, "tasks");
  if (assignmentRows) assertUniqueIds(assignmentRows, "assignments");
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

  if (assignmentRows) statements.push(db.delete(assignments));

  // D1 allows at most 100 bound parameters per statement. A batch stays atomic.
  for (const rows of chunks(taskRows, 14)) statements.push(db.insert(tasks).values(rows));
  for (const rows of chunks(assignmentRows ?? [], 12)) statements.push(db.insert(assignments).values(rows));
  for (const rows of chunks(goalRows, 11)) statements.push(db.insert(goals).values(rows));
  for (const rows of chunks(entryRows, 12)) statements.push(db.insert(journalEntries).values(rows));
  for (const rows of chunks(eventRows, 12)) statements.push(db.insert(calendarEvents).values(rows));
  for (const rows of chunks(ideaRows, 14)) statements.push(db.insert(ideas).values(rows));
  if (financeState) {
    statements.push(
      db.insert(settings)
        .values({ key: FINANCE_STATE_KEY, value: JSON.stringify(financeState), updatedAt: nowIso() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: JSON.stringify(financeState), updatedAt: nowIso() },
        }),
    );
  }
  statements.push(
    db.insert(settings)
      .values({ key: SYNC_STATE_KEY, value: clientUpdatedAt, updatedAt: nowIso() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: clientUpdatedAt, updatedAt: nowIso() },
      }),
  );

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  // Медиа выживших записей остаётся нетронутым; файлы и метаданные
  // удалённых записей вычищаются из D1 и R2 после успешной замены.
  await pruneOrphanedMedia(entryRows.map((row) => row.id));

  return jsonOk({
    tasks: taskRows.length,
    assignments: assignmentRows?.length ?? "unchanged",
    goals: goalRows.length,
    entries: entryRows.length,
    events: eventRows.length,
    ideas: ideaRows.length,
    finances: financeState ? "saved" : "unchanged",
    syncUpdatedAt: clientUpdatedAt,
  });
});
