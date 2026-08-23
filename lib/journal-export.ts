// Сборка экспорта дневника и полного бэкапа (клиентская сторона).
// Файлы: manifest, полный JSON, markdown, транскрипты и оригиналы медиа.
// Секреты в бэкап не попадают по построению: метаданные не содержат токенов.
import type { JournalEntry, JournalMedia } from "./types";
import { extensionForMime, formatDuration } from "./media-limits";
import { buildZip, type ZipInputEntry } from "./zip";

export function mediaFileName(media: JournalMedia): string {
  return `${media.id}.${extensionForMime(media.mimeType)}`;
}

function entryHeading(entry: JournalEntry): string {
  return entry.title?.trim() || "Запись дневника";
}

export function entryToMarkdown(entry: JournalEntry): string {
  const lines: string[] = [`# ${entryHeading(entry)}`, "", `Дата: ${entry.date}`];
  if (entry.mood) lines.push(`Настроение: ${entry.mood}`);
  if (entry.tags.length) lines.push(`Теги: ${entry.tags.map((tag) => `#${tag}`).join(" ")}`);
  lines.push("");
  if ((entry.body ?? "").trim()) {
    lines.push((entry.body ?? "").trim(), "");
  }
  for (const media of entry.media ?? []) {
    const label = media.type === "video" ? "Видео" : "Аудио";
    const duration = formatDuration(media.durationMs);
    lines.push(`## ${label}${duration ? ` · ${duration}` : ""}`, "");
    lines.push(`Файл: media/${entry.id}/${mediaFileName(media)}`);
    if (media.transcript) {
      lines.push("", media.transcript);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function journalToMarkdown(entries: JournalEntry[]): string {
  return entries.map(entryToMarkdown).join("\n---\n\n");
}

export type BackupProgress = { filesDone: number; filesTotal: number; current: string };

type ManifestMedia = {
  id: string;
  type: JournalMedia["type"];
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  file: string;
  transcript: string | null;
  transcriptEdited: boolean;
};

// Открытый дамп без бинарных данных — его можно спокойно проверять и парсить.
export function buildBackupManifest(entries: JournalEntry[], exportedAt: string) {
  let audio = 0;
  let video = 0;
  for (const entry of entries) {
    for (const media of entry.media ?? []) {
      if (media.type === "video") video += 1;
      else audio += 1;
    }
  }
  return {
    app: "workazy",
    version: 1,
    exportedAt,
    counts: { entries: entries.length, audio, video },
    entries: entries.map((entry) => ({
      id: entry.id,
      date: entry.date,
      title: entry.title?.trim() || null,
        hasBody: Boolean((entry.body ?? "").trim()),
      mood: entry.mood ?? null,
      tags: entry.tags,
      media: (entry.media ?? []).map<ManifestMedia>((media) => ({
        id: media.id,
        type: media.type,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        durationMs: media.durationMs,
        file: `media/${entry.id}/${mediaFileName(media)}`,
        transcript: media.transcript ?? null,
        transcriptEdited: media.transcriptEdited,
      })),
    })),
  };
}

// Полный бэкап дневника в ZIP. Байты медиа скачивает вызывающая сторона
// по подписанным ссылкам — здесь только сборка структуры архива.
export async function createJournalBackupZip(
  entries: JournalEntry[],
  downloadMedia: (media: JournalMedia) => Promise<Uint8Array>,
  onProgress?: (progress: BackupProgress) => void,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const allMedia = entries.flatMap((entry) => entry.media ?? []);
  const filesTotal = allMedia.length;
  const zipEntries: ZipInputEntry[] = [];

  const exportedAt = new Date().toISOString();
  zipEntries.push({ name: "journal/manifest.json", data: encoder.encode(JSON.stringify(buildBackupManifest(entries, exportedAt), null, 2)) });
  zipEntries.push({ name: "journal/entries.json", data: encoder.encode(JSON.stringify(entries, null, 2)) });
  zipEntries.push({ name: "journal/journal.md", data: encoder.encode(journalToMarkdown(entries)) });

  for (const entry of entries) {
    zipEntries.push({ name: `journal/entries/${entry.id}.md`, data: encoder.encode(entryToMarkdown(entry)) });
    zipEntries.push({ name: `journal/entries/${entry.id}.json`, data: encoder.encode(JSON.stringify(entry, null, 2)) });
    for (const media of entry.media ?? []) {
      if (media.transcript) {
        zipEntries.push({ name: `journal/transcripts/${entry.id}/${media.id}.txt`, data: encoder.encode(media.transcript) });
      }
    }
  }

  let filesDone = 0;
  for (const entry of entries) {
    for (const media of entry.media ?? []) {
      onProgress?.({ filesDone, filesTotal, current: mediaFileName(media) });
      const bytes = await downloadMedia(media);
      zipEntries.push({ name: `journal/media/${entry.id}/${mediaFileName(media)}`, data: bytes });
      filesDone += 1;
      onProgress?.({ filesDone, filesTotal, current: mediaFileName(media) });
    }
  }

  return buildZip(zipEntries);
}

// Браузерное скачивание готового файла.
export function downloadBlob(data: Blob | Uint8Array | string, fileName: string, mimeType = "application/octet-stream") {
  const blob = data instanceof Blob
    ? data
    : typeof data === "string"
      ? new Blob([data], { type: mimeType })
      : new Blob([data as unknown as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
