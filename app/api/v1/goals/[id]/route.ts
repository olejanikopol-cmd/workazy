export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { goals } from "@/db/schema";
import { ApiError, goalToJson, jsonOk, nowIso, readBool, readIdParam, readInt, readIsoDate, readJsonBody, readOneOf, readOptionalText, withApi } from "@/lib/api";

const PERIODS = ["week", "month", "year"] as const;

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const rows = await db.select().from(goals).where(eq(goals.id, id)).limit(1);
  if (!rows.length) throw new ApiError(404, "Цель не найдена");
  return jsonOk(goalToJson(rows[0]));
});

export const PATCH = withApi(async (request, context) => {
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  const title = readOptionalText(body.title, "title", { maxLength: 300 });
  const description = readOptionalText(body.description, "description", { maxLength: 1000 });
  const period = readOneOf(body.period, "period", PERIODS, { required: false });
  const progress = readInt(body.progress, "progress", { min: 0, max: 100 });
  const deadline = readIsoDate(body.deadline, "deadline", { required: false });
  const completed = readBool(body.completed, "completed");

  const changes: Partial<typeof goals.$inferInsert> = { updatedAt: nowIso() };
  if (title === null) throw new ApiError(400, "Заголовок цели нельзя очистить");
  if (title !== undefined) changes.title = title;
  if (description !== undefined) changes.description = description;
  if (period !== undefined) changes.period = period;
  if (progress !== undefined) changes.progress = progress;
  if (deadline !== undefined) changes.deadline = deadline;
  if (completed !== undefined) changes.completed = completed;

  const db = await getDb();
  const result = await db.update(goals).set(changes).where(eq(goals.id, id)).returning();
  if (!result.length) throw new ApiError(404, "Цель не найдена");
  return jsonOk(goalToJson(result[0]));
});

export const DELETE = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const result = await db.delete(goals).where(eq(goals.id, id)).returning({ id: goals.id });
  if (!result.length) throw new ApiError(404, "Цель не найдена");
  return jsonOk({ deleted: true });
});
