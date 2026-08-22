export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { ApiError, eventToJson, jsonOk, nowIso, readIdParam, readIsoDate, readJsonBody, readOptionalText, readOptionalTime, withApi } from "@/lib/api";

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
  if (!rows.length) throw new ApiError(404, "Событие не найдено");
  return jsonOk(eventToJson(rows[0]));
});

export const PATCH = withApi(async (request, context) => {
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  const title = readOptionalText(body.title, "title", { maxLength: 300 });
  const date = readIsoDate(body.date, "date", { required: false });
  const time = readOptionalTime(body.time, "time");
  const note = readOptionalText(body.note, "note", { maxLength: 1000 });
  const reminder = readOptionalText(body.reminder, "reminder", { maxLength: 200 });

  const changes: Partial<typeof calendarEvents.$inferInsert> = { updatedAt: nowIso() };
  if (title === null) throw new ApiError(400, "Заголовок события нельзя очистить");
  if (title !== undefined) changes.title = title;
  if (date !== undefined) changes.date = date;
  if (time !== undefined) changes.time = time;
  if (note !== undefined) changes.note = note;
  if (reminder !== undefined) changes.reminder = reminder;

  const db = await getDb();
  const result = await db.update(calendarEvents).set(changes).where(eq(calendarEvents.id, id)).returning();
  if (!result.length) throw new ApiError(404, "Событие не найдено");
  return jsonOk(eventToJson(result[0]));
});

export const DELETE = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const result = await db.delete(calendarEvents).where(eq(calendarEvents.id, id)).returning({ id: calendarEvents.id });
  if (!result.length) throw new ApiError(404, "Событие не найдено");
  return jsonOk({ deleted: true });
});
