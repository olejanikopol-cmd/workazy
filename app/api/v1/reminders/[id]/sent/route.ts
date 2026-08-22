export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { reminderLogs } from "@/db/schema";
import { ApiError, jsonOk, nowIso, readIdParam, reminderToJson, withApi } from "@/lib/api";

export const POST = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) throw new ApiError(400, "Некорректный идентификатор напоминания");

  const db = await getDb();
  const result = await db
    .update(reminderLogs)
    .set({ status: "sent", sentAt: nowIso() })
    .where(eq(reminderLogs.id, numericId))
    .returning();
  if (!result.length) throw new ApiError(404, "Напоминание не найдено");
  return jsonOk(reminderToJson(result[0]));
});