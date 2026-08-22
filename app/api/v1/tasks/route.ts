export const dynamic = "force-dynamic";

import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { tasks } from "@/db/schema";
import { jsonOk, newId, nowIso, readBool, readInt, readIsoDate, readJsonBody, requireText, taskToJson, todayDate, withApi } from "@/lib/api";

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const date = readIsoDate(url.searchParams.get("date"), "date", { required: false }) ?? todayDate();
  const db = await getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.date, date))
    .orderBy(asc(tasks.position), asc(tasks.createdAt));
  return jsonOk(rows.map(taskToJson));
});

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  const title = requireText(body.title, "title", { maxLength: 300 });
  const date = readIsoDate(body.date, "date", { required: false }) ?? todayDate();
  const completed = readBool(body.completed, "completed") ?? false;
  const position = readInt(body.position, "position", { min: 0, max: 10000 }) ?? 0;
  const now = nowIso();
  const row = { id: newId("task"), title, date, completed, position, createdAt: now, updatedAt: now };
  const db = await getDb();
  await db.insert(tasks).values(row);
  return jsonOk(taskToJson(row), 201);
});