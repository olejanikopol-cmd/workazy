export const dynamic = "force-dynamic";

import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { journalEntries } from "@/db/schema";
import { entryToJson, jsonOk, newId, nowIso, readIsoDate, readJsonBody, readOptionalText, readTags, requireText, withApi } from "@/lib/api";

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const date = readIsoDate(url.searchParams.get("date"), "date", { required: false });
  const db = await getDb();
  const rows = date
    ? await db.select().from(journalEntries).where(eq(journalEntries.date, date)).orderBy(desc(journalEntries.createdAt))
    : await db.select().from(journalEntries).orderBy(desc(journalEntries.date), desc(journalEntries.createdAt)).limit(50);
  return jsonOk(rows.map(entryToJson));
});

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  const date = readIsoDate(body.date, "date", { required: false }) ?? nowIso().slice(0, 10);
  const title = readOptionalText(body.title, "title", { maxLength: 300 }) ?? null;
  const entryBody = requireText(body.body, "body", { maxLength: 5000 });
  const mood = readOptionalText(body.mood, "mood", { maxLength: 60 }) ?? null;
  const tags = readTags(body.tags, "tags");
  const now = nowIso();
  const row = { id: newId("entry"), date, title, body: entryBody, mood, tags: JSON.stringify(tags), createdAt: now, updatedAt: now };
  const db = await getDb();
  await db.insert(journalEntries).values(row);
  return jsonOk(entryToJson(row), 201);
});