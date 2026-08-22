export const dynamic = "force-dynamic";

import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents } from "@/db/schema";
import { eventToJson, jsonOk, newId, nowIso, readIsoDate, readJsonBody, readOptionalText, readOptionalTime, requireIsoDate, requireText, withApi } from "@/lib/api";

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const date = readIsoDate(url.searchParams.get("date"), "date", { required: false });
  const db = await getDb();
  const rows = date
    ? await db.select().from(calendarEvents).where(eq(calendarEvents.date, date)).orderBy(asc(calendarEvents.time))
    : await db.select().from(calendarEvents).orderBy(asc(calendarEvents.date), asc(calendarEvents.time)).limit(100);
  return jsonOk(rows.map(eventToJson));
});

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  const title = requireText(body.title, "title", { maxLength: 300 });
  const date = requireIsoDate(body.date, "date");
  const time = readOptionalTime(body.time, "time") ?? null;
  const note = readOptionalText(body.note, "note", { maxLength: 1000 }) ?? null;
  const reminder = readOptionalText(body.reminder, "reminder", { maxLength: 200 }) ?? null;
  const now = nowIso();
  const row = { id: newId("event"), title, date, time, note, reminder, createdAt: now, updatedAt: now };
  const db = await getDb();
  await db.insert(calendarEvents).values(row);
  return jsonOk(eventToJson(row), 201);
});
