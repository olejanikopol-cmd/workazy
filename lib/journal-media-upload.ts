import { getDb } from "@/db";
import { ApiError, newId, readInt, readOptionalText, requireOneOf, requireResourceId } from "./api";
import {
  AUDIO_MIME_TYPES,
  MAX_AUDIO_DURATION_MS,
  MAX_AUDIO_SIZE_BYTES,
  MAX_VIDEO_DURATION_MS,
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_MIME_TYPES,
  extensionForMime,
  mediaHeaderMatchesMime,
  normalizeMime,
} from "./media-limits";
import { MEDIA_UPLOAD_CHUNK_SIZE_BYTES, mediaChunkBounds, mediaChunkCount } from "./media-upload";
import {
  findMediaRow,
  mediaToJson,
  persistUploadedJournalMedia,
  requireEntryExists,
} from "./journal-media";
import {
  MEDIA_KEY_PREFIX,
  deleteR2Objects,
  getMediaBucket,
  putConcatenatedR2Objects,
} from "./r2";
import { ensureMediaStorageReady } from "./storage-health";
import type { JournalMedia } from "./types";

const UPLOAD_KEY_PREFIX = "journal-media-uploads/";
const UPLOAD_TTL_MS = 24 * 60 * 60_000;

type UploadKind = "main" | "track";

type UploadFile = {
  sizeBytes: number;
  mimeType: string;
  fileName?: string;
  partCount: number;
  finalKey: string;
};

type UploadManifest = {
  version: 1;
  id: string;
  journalEntryId: string;
  type: "audio" | "video";
  main: UploadFile;
  track: UploadFile | null;
  durationMs?: number;
  width?: number;
  height?: number;
  createdAt: string;
  expiresAt: string;
};

export type MediaUploadSession = {
  id: string;
  chunkSizeBytes: number;
  main: { partCount: number; sizeBytes: number };
  track: { partCount: number; sizeBytes: number } | null;
};

function manifestKey(id: string): string {
  return `${UPLOAD_KEY_PREFIX}${id}/manifest.json`;
}

function chunkKey(id: string, kind: UploadKind, part: number): string {
  return `${UPLOAD_KEY_PREFIX}${id}/${kind}/${part}`;
}

function chunkKeys(manifest: UploadManifest, kind: UploadKind): string[] {
  const file = kind === "main" ? manifest.main : manifest.track;
  return file ? Array.from({ length: file.partCount }, (_, part) => chunkKey(manifest.id, kind, part)) : [];
}

function allTemporaryKeys(manifest: UploadManifest): string[] {
  return [manifestKey(manifest.id), ...chunkKeys(manifest, "main"), ...chunkKeys(manifest, "track")];
}

function readFileDescriptor(value: unknown, field: string, allowed: readonly string[], maxSizeBytes: number): {
  sizeBytes: number;
  mimeType: string;
  fileName?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, `Поле «${field}» обязательно`);
  }
  const descriptor = value as Record<string, unknown>;
  const sizeBytes = readInt(descriptor.sizeBytes, `${field}.sizeBytes`, { min: 1, max: maxSizeBytes });
  if (!sizeBytes) throw new ApiError(400, `Поле «${field}.sizeBytes» обязательно`);
  const mimeType = normalizeMime(typeof descriptor.mimeType === "string" ? descriptor.mimeType : "");
  if (!allowed.includes(mimeType)) {
    throw new ApiError(400, `Неподдерживаемый MIME в поле «${field}.mimeType»`);
  }
  const fileName = readOptionalText(descriptor.fileName, `${field}.fileName`, { maxLength: 255 }) ?? undefined;
  return { sizeBytes, mimeType, fileName };
}

function validateManifest(value: unknown, expectedId: string): UploadManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(500, "Сессия загрузки повреждена");
  const manifest = value as UploadManifest;
  if (manifest.version !== 1 || manifest.id !== expectedId || !manifest.main?.partCount) {
    throw new ApiError(500, "Сессия загрузки повреждена");
  }
  return manifest;
}

async function readManifest(id: string, { allowExpired = false }: { allowExpired?: boolean } = {}): Promise<UploadManifest> {
  const bucket = await getMediaBucket();
  const object = await bucket.get(manifestKey(id));
  if (!object) throw new ApiError(404, "Сессия загрузки не найдена");
  let parsed: unknown;
  try {
    parsed = await new Response(object.body).json();
  } catch {
    throw new ApiError(500, "Сессия загрузки повреждена");
  }
  const manifest = validateManifest(parsed, id);
  if (!allowExpired && Date.parse(manifest.expiresAt) <= Date.now()) {
    await deleteR2Objects(allTemporaryKeys(manifest));
    throw new ApiError(410, "Сессия загрузки истекла. Начните загрузку заново");
  }
  return manifest;
}

export async function createJournalMediaUpload(body: Record<string, unknown>): Promise<MediaUploadSession> {
  await ensureMediaStorageReady();
  const journalEntryId = requireResourceId(body.journalEntryId, "journalEntryId");
  const type = requireOneOf(body.type, "type", ["audio", "video"] as const);
  const main = readFileDescriptor(
    body.file,
    "file",
    type === "audio" ? AUDIO_MIME_TYPES : VIDEO_MIME_TYPES,
    type === "audio" ? MAX_AUDIO_SIZE_BYTES : MAX_VIDEO_SIZE_BYTES,
  );
  const trackDescriptor = body.audioTrack === undefined || body.audioTrack === null
    ? null
    : readFileDescriptor(body.audioTrack, "audioTrack", AUDIO_MIME_TYPES, MAX_AUDIO_SIZE_BYTES);
  if (type === "audio" && trackDescriptor) throw new ApiError(400, "Отдельная аудиодорожка доступна только для видео");

  const durationMs = readInt(body.durationMs, "durationMs", {
    min: 1,
    max: type === "audio" ? MAX_AUDIO_DURATION_MS : MAX_VIDEO_DURATION_MS,
  });
  const width = readInt(body.width, "width", { min: 1, max: 10000 });
  const height = readInt(body.height, "height", { min: 1, max: 10000 });
  const database = await getDb();
  await requireEntryExists(database, journalEntryId);

  const id = newId("media");
  const folder = `${MEDIA_KEY_PREFIX}${journalEntryId}`;
  const now = new Date();
  const manifest: UploadManifest = {
    version: 1,
    id,
    journalEntryId,
    type,
    main: {
      ...main,
      partCount: mediaChunkCount(main.sizeBytes),
      finalKey: `${folder}/${id}.${extensionForMime(main.mimeType)}`,
    },
    track: trackDescriptor ? {
      ...trackDescriptor,
      partCount: mediaChunkCount(trackDescriptor.sizeBytes),
      finalKey: `${folder}/${id}-track.${extensionForMime(trackDescriptor.mimeType)}`,
    } : null,
    durationMs,
    width,
    height,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS).toISOString(),
  };

  const bucket = await getMediaBucket();
  await bucket.put(manifestKey(id), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { kind: "journal-media-upload-session" },
  });
  return {
    id,
    chunkSizeBytes: MEDIA_UPLOAD_CHUNK_SIZE_BYTES,
    main: { partCount: manifest.main.partCount, sizeBytes: manifest.main.sizeBytes },
    track: manifest.track ? { partCount: manifest.track.partCount, sizeBytes: manifest.track.sizeBytes } : null,
  };
}

async function readChunkBody(request: Request, expectedSize: number): Promise<Uint8Array> {
  const declaredSize = request.headers.get("content-length");
  if (declaredSize && Number(declaredSize) !== expectedSize) {
    throw new ApiError(400, "Размер чанка не совпадает с ожидаемым");
  }
  if (!request.body) throw new ApiError(400, "Чанк пустой");
  const bytes = new Uint8Array(expectedSize);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedSize) throw new ApiError(413, "Чанк превышает допустимый размер");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedSize) throw new ApiError(400, "Чанк загружен не полностью");
  return bytes;
}

export async function uploadJournalMediaChunk(
  uploadId: string,
  kindValue: string,
  partValue: string,
  request: Request,
): Promise<{ part: number; sizeBytes: number }> {
  const id = requireResourceId(uploadId, "id");
  const kind = requireOneOf(kindValue, "kind", ["main", "track"] as const);
  if (!/^\d+$/.test(partValue)) throw new ApiError(400, "Некорректный номер чанка");
  const part = Number(partValue);
  const manifest = await readManifest(id);
  const file = kind === "main" ? manifest.main : manifest.track;
  if (!file) throw new ApiError(400, "Для этой загрузки нет аудиодорожки");
  let bounds: ReturnType<typeof mediaChunkBounds>;
  try {
    bounds = mediaChunkBounds(file.sizeBytes, part);
  } catch {
    throw new ApiError(400, "Некорректный номер чанка");
  }
  const bytes = await readChunkBody(request, bounds.size);
  if (part === 0 && !mediaHeaderMatchesMime(file.mimeType, bytes.subarray(0, 16))) {
    throw new ApiError(400, "Содержимое файла не соответствует заявленному MIME");
  }

  const bucket = await getMediaBucket();
  const key = chunkKey(id, kind, part);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { uploadId: id, kind, part: String(part) },
  });
  // Abort мог прийти параллельно с PUT. Не оставляем чанк без manifest.
  if (!await bucket.head(manifestKey(id))) {
    await bucket.delete(key);
    throw new ApiError(410, "Сессия загрузки отменена");
  }
  return { part, sizeBytes: bytes.byteLength };
}

async function uploadedParts(manifest: UploadManifest, kind: UploadKind): Promise<number[]> {
  const file = kind === "main" ? manifest.main : manifest.track;
  if (!file) return [];
  const bucket = await getMediaBucket();
  const uploaded: number[] = [];
  for (let start = 0; start < file.partCount; start += 20) {
    const end = Math.min(file.partCount, start + 20);
    const heads = await Promise.all(
      Array.from({ length: end - start }, (_, offset) => bucket.head(chunkKey(manifest.id, kind, start + offset))),
    );
    heads.forEach((head, offset) => {
      const part = start + offset;
      if (head?.size === mediaChunkBounds(file.sizeBytes, part).size) uploaded.push(part);
    });
  }
  return uploaded;
}

export async function getJournalMediaUploadStatus(uploadId: string): Promise<{
  id: string;
  main: number[];
  track: number[];
}> {
  const manifest = await readManifest(requireResourceId(uploadId, "id"));
  const [main, track] = await Promise.all([
    uploadedParts(manifest, "main"),
    uploadedParts(manifest, "track"),
  ]);
  return { id: manifest.id, main, track };
}

async function requireCompleteFile(manifest: UploadManifest, kind: UploadKind): Promise<string[]> {
  const file = kind === "main" ? manifest.main : manifest.track;
  if (!file) return [];
  const uploaded = await uploadedParts(manifest, kind);
  if (uploaded.length !== file.partCount) {
    throw new ApiError(409, `Загружено ${uploaded.length} из ${file.partCount} чанков`);
  }
  return chunkKeys(manifest, kind);
}

export async function completeJournalMediaUpload(uploadId: string): Promise<JournalMedia> {
  const id = requireResourceId(uploadId, "id");
  const existing = await findMediaRow(id);
  if (existing) return mediaToJson(existing);

  const manifest = await readManifest(id);
  await ensureMediaStorageReady();
  const database = await getDb();
  await requireEntryExists(database, manifest.journalEntryId);
  const mainKeys = await requireCompleteFile(manifest, "main");
  const trackKeys = await requireCompleteFile(manifest, "track");
  const bucket = await getMediaBucket();

  try {
    await putConcatenatedR2Objects(bucket, manifest.main.finalKey, mainKeys, {
      sizeBytes: manifest.main.sizeBytes,
      contentType: manifest.main.mimeType,
      customMetadata: { mediaId: id, journalEntryId: manifest.journalEntryId },
    });
    if (manifest.track) {
      await putConcatenatedR2Objects(bucket, manifest.track.finalKey, trackKeys, {
        sizeBytes: manifest.track.sizeBytes,
        contentType: manifest.track.mimeType,
        customMetadata: { mediaId: id, journalEntryId: manifest.journalEntryId, kind: "transcription-track" },
      });
    }

    const media = await persistUploadedJournalMedia({
      mediaId: id,
      journalEntryId: manifest.journalEntryId,
      type: manifest.type,
      storageKey: manifest.main.finalKey,
      transcriptionInputKey: manifest.track?.finalKey,
      mimeType: manifest.main.mimeType,
      fileName: manifest.main.fileName,
      sizeBytes: manifest.main.sizeBytes,
      durationMs: manifest.durationMs,
      width: manifest.width,
      height: manifest.height,
    });
    await deleteR2Objects(allTemporaryKeys(manifest)).catch((error) => {
      console.error("Workazy media upload temporary cleanup failed", {
        uploadId: id,
        cause: error instanceof Error ? error.message : String(error),
      });
    });
    return media;
  } catch (error) {
    const completedByAnotherRequest = await findMediaRow(id).catch(() => null);
    if (completedByAnotherRequest) {
      await deleteR2Objects(allTemporaryKeys(manifest)).catch(() => undefined);
      return mediaToJson(completedByAnotherRequest);
    }
    // Metadata ещё не создана: итоговые объекты недостижимы и удаляются.
    // Временные чанки остаются до abort/retry, поэтому complete можно повторить.
    await deleteR2Objects([
      manifest.main.finalKey,
      ...(manifest.track ? [manifest.track.finalKey] : []),
    ]).catch(() => undefined);
    throw error;
  }
}

export async function abortJournalMediaUpload(uploadId: string): Promise<void> {
  const id = requireResourceId(uploadId, "id");
  let manifest: UploadManifest;
  try {
    manifest = await readManifest(id, { allowExpired: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
  await deleteR2Objects(allTemporaryKeys(manifest));
}
