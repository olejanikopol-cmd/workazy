// Общие ограничения голосовых и видеозаписей дневника.
// Клиент проверяет их до отправки, сервер — до сохранения в R2.
export const MAX_AUDIO_DURATION_MS = 15 * 60_000;
export const MAX_VIDEO_DURATION_MS = 10 * 60_000;
export const MAX_AUDIO_SIZE_BYTES = 24 * 1024 * 1024;
export const MAX_VIDEO_SIZE_BYTES = 80 * 1024 * 1024;
// Личные дневниковые ролики: без гигабайтов, но и без каши.
// Вместе с аудио оставляет 10-минутной записи запас до серверного лимита 80 MiB.
export const VIDEO_BITS_PER_SECOND = 900_000;
export const AUDIO_BITS_PER_SECOND = 96_000;

export const AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
] as const;

export const VIDEO_MIME_TYPES = ["video/webm", "video/mp4", "video/quicktime"] as const;

export function normalizeMime(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

// Расширение для сохранённого файла: формат не переименовывается принудительно,
// расширение следует из фактического MIME записи.
export function extensionForMime(mimeType: string): string {
  const base = normalizeMime(mimeType);
  const known: Record<string, string> = {
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "video/webm": "webm",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
  };
  return known[base] ?? "bin";
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

// MIME в multipart задаёт клиент, поэтому перед R2 сверяем его с сигнатурой
// контейнера. Это не декодер, но блокирует простую загрузку произвольных файлов.
export function mediaHeaderMatchesMime(mimeType: string, bytes: Uint8Array): boolean {
  switch (normalizeMime(mimeType)) {
    case "audio/webm":
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/mp4":
    case "audio/x-m4a":
    case "video/mp4":
    case "video/quicktime":
      return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4); // ftyp
    case "audio/ogg":
      return startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]); // OggS
    case "audio/wav":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8); // RIFF/WAVE
    case "audio/mpeg":
      return startsWith(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    default:
      return false;
  }
}

export function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs < 0) return "";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0 КБ";
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} КБ`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}
