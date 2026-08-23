export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { journalEntries } from "@/db/schema";
import { ApiError, entryToJson, jsonOk, nowIso, readIdParam, readIsoDate, readJsonBody, readOptionalText, readTags, withApi } from "@/lib/api";
import { attachEntryMedia, deleteMediaForEntries, listAllMedia, listMediaByEntry } from "@/lib/journal-media";

export const GET = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const rows = await db.select().from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
  if (!rows.length) throw new ApiError(404, "Запись дневника не найдена");
  const mediaByEntry = await listAllMedia(db);
  return jsonOk(attachEntryMedia(rows.map(entryToJson), mediaByEntry)[0]);
});

export const PATCH = withApi(async (request, context) => {
  const id = await readIdParam(context);
  const body = await readJsonBody(request);
  const date = readIsoDate(body.date, "date", { required: false });
  const title = readOptionalText(body.title, "title", { maxLength: 300 });
  const entryBody = readOptionalText(body.body, "body", { maxLength: 5000 });
  const mood = readOptionalText(body.mood, "mood", { maxLength: 60 });
  const tags = body.tags === undefined ? undefined : readTags(body.tags, "tags");

  const db = await getDb();
  const changes: Partial<typeof journalEntries.$inferInsert> = { updatedAt: nowIso() };
  if (date !== undefined) changes.date = date;
  if (title !== undefined) changes.title = title;
  if (entryBody === null) {
    // Текст можно очистить, только если в записи остались аудио или видео.
    const media = await listMediaByEntry(db, id);
    if (!media.length) throw new ApiError(400, "Текст записи нельзя очистить, пока в ней нет аудио или видео");
    changes.body = null;
  }
  if (entryBody !== undefined && entryBody !== null) changes.body = entryBody;
  if (mood !== undefined) changes.mood = mood;
  if (tags !== undefined) changes.tags = JSON.stringify(tags);

  const result = await db.update(journalEntries).set(changes).where(eq(journalEntries.id, id)).returning();
  if (!result.length) throw new ApiError(404, "Запись дневника не найдена");
  const media = await listMediaByEntry(db, id);
  return jsonOk({ ...entryToJson(result[0]), media });
});

export const DELETE = withApi(async (_request, context) => {
  const id = await readIdParam(context);
  const db = await getDb();
  const existing = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
  if (!existing.length) throw new ApiError(404, "Запись дневника не найдена");
  // Сначала медиа (строки и объекты R2), затем сама запись.
  await deleteMediaForEntries([id]);
  await db.delete(journalEntries).where(eq(journalEntries.id, id));
  return jsonOk({ deleted: true });
});
