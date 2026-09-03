import { asc, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "@/db";
import { assignments, tasks } from "@/db/schema";

// Три одинаковых задания были созданы старой схемой Workazy GPT через
// /api/v1/tasks прямо перед переходом на отдельную таблицу assignments.
// Переносим один экземпляр и удаляем дубли из ежедневного плана.
const LEGACY_CHATGPT_TASK_IDS = [
  "task-1787803987213-sc2cw",
  "task-1787804044422-hbf3k",
  "task-1787804090419-h83vh",
] as const;

const LEGACY_TARGET_ID = "task-1787804090419-h83vh";

export async function backfillLegacyChatGptAssignment(db: Awaited<ReturnType<typeof getDb>>) {
  const rows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, [...LEGACY_CHATGPT_TASK_IDS]))
    .orderBy(asc(tasks.createdAt));
  if (!rows.length) return;

  const target = rows.find((row) => row.id === LEGACY_TARGET_ID) ?? rows[rows.length - 1];
  const statements: BatchItem<"sqlite">[] = [
    db.insert(assignments).values({
      id: LEGACY_TARGET_ID,
      title: target.title,
      description: null,
      dueDate: null,
      completed: target.completed,
      createdAt: rows[0].createdAt,
      updatedAt: target.updatedAt,
    }).onConflictDoNothing(),
    db.delete(tasks).where(inArray(tasks.id, [...LEGACY_CHATGPT_TASK_IDS])),
  ];
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}
