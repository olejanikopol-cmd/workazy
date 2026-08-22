export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { tasks } from "@/db/schema";
import { ApiError, jsonOk, nowIso, readBool, readIdParam, readInt, readIsoDate, readJsonBody, readText, taskToJson, withApi } from "@/lib/api";

async function getTask(id: string) {
  const db = await getDb();
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!rows.length) throw new ApiError(404, "Задача не найдена");
  return rows[0];
}

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  return jsonOk(taskToJson(await getTask(id)));
});

export const PATCH = withApi(async (request, context) => {
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  const title = readText(body.title, "title", { required: false, maxLength: 300 });
  const date = readIsoDate(body.date, "date", { required: false });
  const completed = readBool(body.completed, "completed");
  const position = readInt(body.position, "position", { min: 0, max: 10000 });

  const changes: Partial<typeof tasks.$inferInsert> = { updatedAt: nowIso() };
  if (title !== undefined) changes.title = title;
  if (date !== undefined) changes.date = date;
  if (completed !== undefined) changes.completed = completed;
  if (position !== undefined) changes.position = position;

  const db = await getDb();
  const result = await db.update(tasks).set(changes).where(eq(tasks.id, id)).returning();
  if (!result.length) throw new ApiError(404, "Задача не найдена");
  return jsonOk(taskToJson(result[0]));
});

export const DELETE = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const result = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  if (!result.length) throw new ApiError(404, "Задача не найдена");
  return jsonOk({ deleted: true });
});