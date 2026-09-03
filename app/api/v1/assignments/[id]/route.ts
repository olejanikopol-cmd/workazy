export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { assignments } from "@/db/schema";
import { ApiError, assignmentToJson, jsonOk, nowIso, readBool, readIdParam, readIsoDate, readJsonBody, readOptionalText, readText, withApi } from "@/lib/api";

async function getAssignment(id: string) {
  const db = await getDb();
  const rows = await db.select().from(assignments).where(eq(assignments.id, id)).limit(1);
  if (!rows.length) throw new ApiError(404, "Задание не найдено");
  return rows[0];
}

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  return jsonOk(assignmentToJson(await getAssignment(id)));
});

export const PATCH = withApi(async (request, context) => {
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  const title = readText(body.title, "title", { required: false, maxLength: 300 });
  const description = readOptionalText(body.description, "description", { maxLength: 2000 });
  const dueDate = body.dueDate === null || body.dueDate === ""
    ? null
    : readIsoDate(body.dueDate, "dueDate", { required: false });
  const completed = readBool(body.completed, "completed");

  const changes: Partial<typeof assignments.$inferInsert> = { updatedAt: nowIso() };
  if (title !== undefined) changes.title = title;
  if (description !== undefined) changes.description = description;
  if (dueDate !== undefined) changes.dueDate = dueDate;
  if (completed !== undefined) changes.completed = completed;

  const db = await getDb();
  const result = await db.update(assignments).set(changes).where(eq(assignments.id, id)).returning();
  if (!result.length) throw new ApiError(404, "Задание не найдено");
  return jsonOk(assignmentToJson(result[0]));
});

export const DELETE = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const result = await db.delete(assignments).where(eq(assignments.id, id)).returning({ id: assignments.id });
  if (!result.length) throw new ApiError(404, "Задание не найдено");
  return jsonOk({ deleted: true });
});
