export const dynamic = "force-dynamic";

import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { journalEntries } from "@/db/schema";
import { entryToJson, jsonOk, newId, nowIso, readIsoDate, readJsonBody, readOptionalText, readTags, requireResourceId, todayDate, ApiError, withApi } from "@/lib/api";
import { attachEntryMedia, listAllMedia } from "@/lib/journal-media";
import { ensureMediaStorageReady } from "@/lib/storage-health";

export const GET = withApi(async (request) => {
  await ensureMediaStorageReady({ requireMedia: false });
  const url = new URL(request.url);
  const date = readIsoDate(url.searchParams.get("date"), "date", { required: false });
  const db = await getDb();
  const rows = date
    ? await db.select().from(journalEntries).where(eq(journalEntries.date, date)).orderBy(desc(journalEntries.createdAt))
    : await db.select().from(journalEntries).orderBy(desc(journalEntries.date), desc(journalEntries.createdAt)).limit(50);
  const mediaByEntry = await listAllMedia(db);
  return jsonOk(attachEntryMedia(rows.map(entryToJson), mediaByEntry));
});

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  // Клиент может передать собственный id (черновики медиа), чтобы вложения
  // привязались к той же записи. Иначе сервер генерирует новый.
  const id = body.id === undefined ? newId("entry") : requireResourceId(body.id, "id");
  const date = readIsoDate(body.date, "date", { required: false }) ?? todayDate();
  const title = readOptionalText(body.title, "title", { maxLength: 300 }) ?? null;
  // Текст необязателен: запись может состоять только из аудио или видео.
  const entryBody = readOptionalText(body.body, "body", { maxLength: 5000 }) ?? null;
  const mood = readOptionalText(body.mood, "mood", { maxLength: 60 }) ?? null;
  const tags = readTags(body.tags, "tags");

  // Media-only entries require the nullable body introduced by migration 0001.
  // The check is idempotent and preserves all legacy rows.
  await ensureMediaStorageReady({ requireMedia: false });
  const db = await getDb();
  if (body.id !== undefined) {
    await requireEntryIdFree(db, id);
  }
  const row = { id, date, title, body: entryBody, mood, tags: JSON.stringify(tags), createdAt: nowIso(), updatedAt: nowIso() };
  await db.insert(journalEntries).values(row);
  return jsonOk(entryToJson(row), 201);
});

async function requireEntryIdFree(db: Awaited<ReturnType<typeof getDb>>, id: string) {
  const existing = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
  if (existing.length) throw new ApiError(409, "Запись с таким id уже существует");
}
