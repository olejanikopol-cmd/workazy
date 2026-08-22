export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ideas } from "@/db/schema";
import { ApiError, ideaToJson, jsonOk, nowIso, readIdParam, readJsonBody, readOneOf, readOptionalText, withApi } from "@/lib/api";

const CATEGORIES = ["thought", "want", "project", "purchase", "someday"] as const;
const STATUSES = ["new", "thinking", "plan", "done", "archive"] as const;

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const rows = await db.select().from(ideas).where(eq(ideas.id, id)).limit(1);
  if (!rows.length) throw new ApiError(404, "Идея не найдена");
  return jsonOk(ideaToJson(rows[0]));
});

export const PATCH = withApi(async (request, context) => {
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  const title = readOptionalText(body.title, "title", { maxLength: 300 });
  const description = readOptionalText(body.description, "description", { maxLength: 2000 });
  const category = readOneOf(body.category, "category", CATEGORIES, { required: false });
  const status = readOneOf(body.status, "status", STATUSES, { required: false });

  const changes: Partial<typeof ideas.$inferInsert> = { updatedAt: nowIso() };
  if (title === null) throw new ApiError(400, "Заголовок идеи нельзя очистить");
  if (title !== undefined) changes.title = title;
  if (description !== undefined) changes.description = description;
  if (category !== undefined) changes.category = category;
  if (status !== undefined) changes.status = status;

  const db = await getDb();
  const result = await db.update(ideas).set(changes).where(eq(ideas.id, id)).returning();
  if (!result.length) throw new ApiError(404, "Идея не найдена");
  return jsonOk(ideaToJson(result[0]));
});

export const DELETE = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const result = await db.delete(ideas).where(eq(ideas.id, id)).returning({ id: ideas.id });
  if (!result.length) throw new ApiError(404, "Идея не найдена");
  return jsonOk({ deleted: true });
});
