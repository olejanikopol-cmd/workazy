export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { tasks } from "@/db/schema";
import { ApiError, jsonOk, nowIso, readIdParam, taskToJson, withApi } from "@/lib/api";

// Отдельное действие «выполнить задачу» для ChatGPT:
// проще и надёжнее, чем PATCH с телом. Тело запроса не требуется.
export const POST = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const result = await db
    .update(tasks)
    .set({ completed: true, updatedAt: nowIso() })
    .where(eq(tasks.id, id))
    .returning();
  if (!result.length) throw new ApiError(404, "Задача не найдена");
  return jsonOk(taskToJson(result[0]));
});
