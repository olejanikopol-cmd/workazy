export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { assignments } from "@/db/schema";
import { ApiError, assignmentToJson, jsonOk, nowIso, readIdParam, withApi } from "@/lib/api";

export const POST = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const result = await db
    .update(assignments)
    .set({ completed: true, updatedAt: nowIso() })
    .where(eq(assignments.id, id))
    .returning();
  if (!result.length) throw new ApiError(404, "Задание не найдено");
  return jsonOk(assignmentToJson(result[0]));
});
