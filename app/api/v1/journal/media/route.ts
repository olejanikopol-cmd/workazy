export const dynamic = "force-dynamic";

// Загрузка аудио/видео дневника: multipart/form-data, поля:
// journalEntryId, type (audio|video), file, опционально
// audioTrack (только для видео), durationMs, width, height.
import { ApiError, jsonOk, readInt, requireOneOf, requireResourceId, withApi } from "@/lib/api";
import {
  AUDIO_MIME_TYPES,
  MAX_AUDIO_DURATION_MS,
  MAX_AUDIO_SIZE_BYTES,
  MAX_VIDEO_DURATION_MS,
  MAX_VIDEO_SIZE_BYTES,
  mediaHeaderMatchesMime,
  normalizeMime,
} from "@/lib/media-limits";
import { uploadJournalMedia } from "@/lib/journal-media";

function formInt(value: FormDataEntryValue | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ApiError(400, `Поле «${field}» должно быть числом`);
  if (!/^\d+$/.test(value.trim())) throw new ApiError(400, `Поле «${field}» должно быть целым числом`);
  return Number(value);
}

async function validateFileHeader(file: File, label: string): Promise<void> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!mediaHeaderMatchesMime(file.type, header)) {
    throw new ApiError(400, `${label}: содержимое файла не соответствует MIME ${file.type || "неизвестен"}`);
  }
}

export const POST = withApi(async (request) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new ApiError(400, "Загрузка медиа ожидает multipart/form-data");
  }
  // Защита от огромных тел до чтения формы (лимит края + запас).
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 100 * 1024 * 1024) {
    throw new ApiError(413, "Файл превышает допустимый размер");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(400, "Не удалось прочитать форму загрузки");
  }

  const journalEntryId = requireResourceId(form.get("journalEntryId"), "journalEntryId");
  const type = requireOneOf(form.get("type"), "type", ["audio", "video"] as const);

  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "Поле «file» обязательно и должно быть файлом");
  if (file.size === 0) throw new ApiError(400, "Файл пустой");
  const maxFileSize = type === "audio" ? MAX_AUDIO_SIZE_BYTES : MAX_VIDEO_SIZE_BYTES;
  if (file.size > maxFileSize) throw new ApiError(413, "Файл превышает допустимый размер");
  await validateFileHeader(file, "Основной файл");

  const audioTrackPart = form.get("audioTrack");
  let audioTrack: { stream: ReadableStream; mimeType: string; fileName?: string } | null = null;
  if (audioTrackPart !== null) {
    if (type === "audio") throw new ApiError(400, "Отдельная аудиодорожка доступна только для видео");
    if (!(audioTrackPart instanceof File)) throw new ApiError(400, "Поле «audioTrack» должно быть файлом");
    if (audioTrackPart.size === 0) throw new ApiError(400, "Аудиодорожка пустая");
    const trackMime = normalizeMime(audioTrackPart.type);
    if (!(AUDIO_MIME_TYPES as readonly string[]).includes(trackMime)) {
      throw new ApiError(400, `Неподдерживаемый формат аудиодорожки: ${audioTrackPart.type || "неизвестен"}`);
    }
    if (audioTrackPart.size > MAX_AUDIO_SIZE_BYTES) throw new ApiError(413, "Аудиодорожка превышает допустимый размер");
    await validateFileHeader(audioTrackPart, "Аудиодорожка");
    audioTrack = { stream: audioTrackPart.stream(), mimeType: audioTrackPart.type, fileName: audioTrackPart.name };
  }

  const durationMs = readInt(formInt(form.get("durationMs"), "durationMs"), "durationMs", {
    min: 1,
    max: type === "audio" ? MAX_AUDIO_DURATION_MS : MAX_VIDEO_DURATION_MS,
  });
  const width = readInt(formInt(form.get("width"), "width"), "width", { min: 1, max: 10000 });
  const height = readInt(formInt(form.get("height"), "height"), "height", { min: 1, max: 10000 });

  const media = await uploadJournalMedia({
    journalEntryId,
    type,
    mimeType: file.type,
    fileStream: file.stream(),
    fileName: file.name || undefined,
    audioTrack,
    durationMs,
    width,
    height,
  });
  return jsonOk(media, 201);
});
