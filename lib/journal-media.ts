// Серверный слой медиа дневника: метаданные в D1, файлы в R2.
// Загрузка, расшифровка, правка транскрипта, удаление и очистка сирот.
import { eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { journalEntries, journalMedia } from "@/db/schema";
import type { JournalMedia } from "./types";
import { ApiError, newId, nowIso } from "./api";
import {
  AUDIO_MIME_TYPES,
  MAX_AUDIO_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_MIME_TYPES,
  extensionForMime,
  normalizeMime,
} from "./media-limits";
import { MEDIA_KEY_PREFIX, deleteR2Objects, getMediaBucket, putStreamLimited, readR2ObjectBytes } from "./r2";
import { getTranscriptionProvider } from "./transcription/provider";
import { ensureMediaStorageReady } from "./storage-health";

export function mediaToJson(row: typeof journalMedia.$inferSelect): JournalMedia {
  return {
    id: row.id,
    journalEntryId: row.journalEntryId,
    type: row.type,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename ?? undefined,
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    transcript: row.transcript ?? undefined,
    transcriptEdited: row.transcriptEdited,
    transcriptionStatus: row.transcriptionStatus,
    transcriptionError: row.transcriptionError ?? undefined,
    transcriptionProvider: row.transcriptionProvider ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listMediaByEntry(database: Db, journalEntryId: string): Promise<JournalMedia[]> {
  await ensureMediaStorageReady({ requireMedia: false });
  const rows = await database.select().from(journalMedia).where(eq(journalMedia.journalEntryId, journalEntryId));
  return rows.map(mediaToJson);
}

// Группировка метаданных по записям — для присоединения к состоянию.
export async function listAllMedia(database: Db): Promise<Map<string, JournalMedia[]>> {
  await ensureMediaStorageReady({ requireMedia: false });
  const rows = await database.select().from(journalMedia);
  const byEntry = new Map<string, JournalMedia[]>();
  for (const row of rows) {
    const media = mediaToJson(row);
    const list = byEntry.get(media.journalEntryId) ?? [];
    list.push(media);
    byEntry.set(media.journalEntryId, list);
  }
  return byEntry;
}

export function attachEntryMedia<T extends { id: string }>(
  entries: T[],
  mediaByEntry: Map<string, JournalMedia[]>,
): (T & { media: JournalMedia[] })[] {
  return entries.map((entry) => ({ ...entry, media: mediaByEntry.get(entry.id) ?? [] }));
}

export async function requireEntryExists(database: Db, journalEntryId: string): Promise<void> {
  const rows = await database
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(eq(journalEntries.id, journalEntryId))
    .limit(1);
  if (!rows.length) throw new ApiError(404, "Запись дневника не найдена");
}

export async function getMediaRow(mediaId: string): Promise<typeof journalMedia.$inferSelect> {
  await ensureMediaStorageReady({ requireMedia: false });
  const database = await getDb();
  const rows = await database.select().from(journalMedia).where(eq(journalMedia.id, mediaId)).limit(1);
  if (!rows.length) throw new ApiError(404, "Файл медиа не найден");
  return rows[0];
}

export async function findMediaRow(mediaId: string): Promise<typeof journalMedia.$inferSelect | null> {
  await ensureMediaStorageReady({ requireMedia: false });
  const database = await getDb();
  const rows = await database.select().from(journalMedia).where(eq(journalMedia.id, mediaId)).limit(1);
  return rows[0] ?? null;
}

// ---------- Загрузка ----------

export type MediaUploadInput = {
  journalEntryId: string;
  type: "audio" | "video";
  mimeType: string;
  fileStream: ReadableStream;
  sizeBytes: number;
  fileName?: string;
  // Отдельная аудиодорожка видео — вход для Whisper и безопасного retry.
  audioTrack?: { stream: ReadableStream; mimeType: string; sizeBytes: number; fileName?: string } | null;
  durationMs?: number;
  width?: number;
  height?: number;
};

export type PersistUploadedMediaInput = {
  mediaId: string;
  journalEntryId: string;
  type: "audio" | "video";
  storageKey: string;
  transcriptionInputKey?: string | null;
  mimeType: string;
  fileName?: string;
  sizeBytes: number;
  durationMs?: number;
  width?: number;
  height?: number;
};

export async function persistUploadedJournalMedia(input: PersistUploadedMediaInput): Promise<JournalMedia> {
  await ensureMediaStorageReady();
  const database = await getDb();
  await requireEntryExists(database, input.journalEntryId);
  const now = nowIso();
  const row: typeof journalMedia.$inferInsert = {
    id: input.mediaId,
    journalEntryId: input.journalEntryId,
    type: input.type,
    storageKey: input.storageKey,
    transcriptionInputKey: input.transcriptionInputKey ?? null,
    mimeType: normalizeMime(input.mimeType),
    originalFilename: input.fileName ?? null,
    sizeBytes: input.sizeBytes,
    durationMs: input.durationMs ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    transcript: null,
    transcriptEdited: false,
    transcriptionStatus: "pending",
    transcriptionError: null,
    transcriptionProvider: null,
    createdAt: now,
    updatedAt: now,
  };
  await database.insert(journalMedia).values(row);
  return mediaToJson(row as typeof journalMedia.$inferSelect);
}

export async function uploadJournalMedia(input: MediaUploadInput): Promise<JournalMedia> {
  const normalizedMime = normalizeMime(input.mimeType);
  const allowed = input.type === "audio" ? AUDIO_MIME_TYPES : VIDEO_MIME_TYPES;
  if (!(allowed as readonly string[]).includes(normalizedMime)) {
    throw new ApiError(400, `Неподдерживаемый формат ${input.type === "audio" ? "аудио" : "видео"}: ${input.mimeType || "неизвестен"}`);
  }
  if (input.type === "audio" && input.audioTrack) {
    throw new ApiError(400, "Отдельная аудиодорожка доступна только для видео");
  }
  const audioTrackMime = input.audioTrack ? normalizeMime(input.audioTrack.mimeType) : null;
  if (audioTrackMime && !(AUDIO_MIME_TYPES as readonly string[]).includes(audioTrackMime)) {
    throw new ApiError(400, `Неподдерживаемый формат аудиодорожки: ${input.audioTrack?.mimeType || "неизвестен"}`);
  }

  await ensureMediaStorageReady();
  const bucket = await getMediaBucket(); // проверяем хранилище до записи метаданных
  const database = await getDb();
  await requireEntryExists(database, input.journalEntryId);

  const mediaId = newId("media");
  const now = nowIso();
  const folder = `${MEDIA_KEY_PREFIX}${input.journalEntryId}`;
  const storageKey = `${folder}/${mediaId}.${extensionForMime(normalizedMime)}`;
  const maxSizeBytes = input.type === "audio" ? MAX_AUDIO_SIZE_BYTES : MAX_VIDEO_SIZE_BYTES;

  const main = await putStreamLimited(bucket, storageKey, input.fileStream, {
    maxSizeBytes,
    expectedSizeBytes: input.sizeBytes,
    contentType: normalizedMime,
    customMetadata: { mediaId, journalEntryId: input.journalEntryId },
  });

  let transcriptionInputKey: string | null = null;
  if (input.audioTrack) {
    const trackKey = `${folder}/${mediaId}-track.${extensionForMime(audioTrackMime ?? "")}`;
    try {
      await putStreamLimited(bucket, trackKey, input.audioTrack.stream, {
        maxSizeBytes: MAX_AUDIO_SIZE_BYTES,
        expectedSizeBytes: input.audioTrack.sizeBytes,
        contentType: audioTrackMime ?? "application/octet-stream",
        customMetadata: { mediaId, journalEntryId: input.journalEntryId, kind: "transcription-track" },
      });
      transcriptionInputKey = trackKey;
    } catch (error) {
      // Трек не сохранился — не оставляем видео-оригинал без расшифровки.
      await deleteR2Objects([storageKey]);
      throw error;
    }
  }

  const row: typeof journalMedia.$inferInsert = {
    id: mediaId,
    journalEntryId: input.journalEntryId,
    type: input.type,
    storageKey,
    transcriptionInputKey,
    mimeType: normalizedMime,
    originalFilename: input.fileName ?? null,
    sizeBytes: main.sizeBytes,
    durationMs: input.durationMs ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    transcript: null,
    transcriptEdited: false,
    transcriptionStatus: "pending",
    transcriptionError: null,
    transcriptionProvider: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await database.insert(journalMedia).values(row);
  } catch (error) {
    await deleteR2Objects([storageKey, ...(transcriptionInputKey ? [transcriptionInputKey] : [])]);
    throw error;
  }

  return mediaToJson(row as typeof journalMedia.$inferSelect);
}

// ---------- Расшифровка ----------

// Запускается по уже сохранённому файлу: сбой транскрипции никогда
// не удаляет медиа. Ошибка фиксируется в статусе и доступна для повтора.
export async function transcribeJournalMedia(mediaId: string): Promise<JournalMedia> {
  const database = await getDb();
  const row = await getMediaRow(mediaId);

  await database
    .update(journalMedia)
    .set({ transcriptionStatus: "processing", transcriptionError: null, updatedAt: nowIso() })
    .where(eq(journalMedia.id, mediaId));

  try {
    if (row.type === "video" && !row.transcriptionInputKey) {
      throw new ApiError(409, "Для этого видео нет отдельной аудиодорожки. Оригинал сохранён, но отправлять весь видеофайл в распознавание небезопасно.");
    }
    const inputKey = row.type === "video" ? row.transcriptionInputKey as string : row.storageKey;
    const bucket = await getMediaBucket();
    const bytes = await readR2ObjectBytes(bucket, inputKey);
    const provider = await getTranscriptionProvider();
    const extension = inputKey.split(".").pop()?.toLowerCase();
    const transcriptionMime = row.type === "audio"
      ? row.mimeType
      : extension === "m4a" || extension === "mp4"
        ? "audio/mp4"
        : extension === "ogg"
          ? "audio/ogg"
          : extension === "mp3"
            ? "audio/mpeg"
            : extension === "wav"
              ? "audio/wav"
              : "audio/webm";
    const result = await provider.transcribe({
      bytes,
      mimeType: transcriptionMime,
      filename: inputKey.split("/").pop() ?? "media",
    });

    const changes: Partial<typeof journalMedia.$inferInsert> = {
      transcript: result.text,
      transcriptEdited: false,
      transcriptionStatus: "ready",
      transcriptionError: null,
      transcriptionProvider: provider.name,
      updatedAt: nowIso(),
    };
    // Аудиодорожку видео сохраняем для безопасного retry: оригинальное видео
    // никогда не отправляется целиком в ASR.
    const updated = await database.update(journalMedia).set(changes).where(eq(journalMedia.id, mediaId)).returning();
    if (!updated.length) throw new ApiError(404, "Файл медиа был удалён во время расшифровки");
    return mediaToJson(updated[0]);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Неизвестная ошибка расшифровки";
    const updated = await database
      .update(journalMedia)
      .set({ transcriptionStatus: "error", transcriptionError: message.slice(0, 500), updatedAt: nowIso() })
      .where(eq(journalMedia.id, mediaId))
      .returning();
    if (!updated.length) throw new ApiError(404, "Файл медиа был удалён во время расшифровки");
    return mediaToJson(updated[0]);
  }
}

// ---------- Правка транскрипта и удаление ----------

export async function updateMediaTranscript(mediaId: string, transcript: string): Promise<JournalMedia> {
  const database = await getDb();
  await getMediaRow(mediaId);
  const updated = await database
    .update(journalMedia)
    .set({
      transcript: transcript || null,
      transcriptEdited: true,
      transcriptionStatus: transcript ? "ready" : "pending",
      transcriptionError: null,
      updatedAt: nowIso(),
    })
    .where(eq(journalMedia.id, mediaId))
    .returning();
  return mediaToJson(updated[0]);
}

export async function deleteJournalMedia(mediaId: string): Promise<void> {
  const database = await getDb();
  const row = await getMediaRow(mediaId);
  await deleteR2Objects([row.storageKey, ...(row.transcriptionInputKey ? [row.transcriptionInputKey] : [])]);
  await database.delete(journalMedia).where(eq(journalMedia.id, mediaId));
}

// Удалить медиа записей (строки + объекты R2). Используется при удалении
// записи дневника и при очистке сирот после полной замены состояния.
export async function deleteMediaForEntries(journalEntryIds: string[]): Promise<void> {
  if (journalEntryIds.length === 0) return;
  const database = await getDb();
  const rows = await database
    .select({ id: journalMedia.id, storageKey: journalMedia.storageKey, transcriptionInputKey: journalMedia.transcriptionInputKey })
    .from(journalMedia)
    .where(inArray(journalMedia.journalEntryId, journalEntryIds));
  if (!rows.length) return;
  const keys: string[] = [];
  for (const row of rows) {
    keys.push(row.storageKey);
    if (row.transcriptionInputKey) keys.push(row.transcriptionInputKey);
  }
  await deleteR2Objects(keys);
  await database.delete(journalMedia).where(inArray(journalMedia.id, rows.map((row) => row.id)));
}

// После PUT /api/v1/state: удалить медиа, чьи записи исчезли из состояния.
// Медиа выживших записей не трогаются никогда.
export async function pruneOrphanedMedia(keepEntryIds: string[]): Promise<void> {
  const database = await getDb();
  const keep = new Set(keepEntryIds);
  const rows = await database
    .select({
      id: journalMedia.id,
      journalEntryId: journalMedia.journalEntryId,
      storageKey: journalMedia.storageKey,
      transcriptionInputKey: journalMedia.transcriptionInputKey,
    })
    .from(journalMedia);
  const orphans = rows.filter((row) => !keep.has(row.journalEntryId));
  if (!orphans.length) return;
  const keys: string[] = [];
  for (const row of orphans) {
    keys.push(row.storageKey);
    if (row.transcriptionInputKey) keys.push(row.transcriptionInputKey);
  }
  await deleteR2Objects(keys);
  await database.delete(journalMedia).where(inArray(journalMedia.id, orphans.map((row) => row.id)));
}
