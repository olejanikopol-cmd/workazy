/**
 * Native journal persistence: single storage key, versioned envelope, strict
 * parser/serializer, and the injected key/value storage interface.
 *
 * Structural parsing only — never input normalization: legacy longer text,
 * unknown moods, empty strings and legacy long tag arrays load unchanged. Any
 * structural violation (bad JSON/version/rows/date/timestamp/duplicate id, bad
 * arrays/types, malformed attachment metadata) rejects the WHOLE snapshot with
 * `load-error` and leaves the stored bytes untouched; nothing is dropped or
 * repaired silently.
 *
 * Attachments are METADATA ONLY and use an explicit schema: unknown attachment
 * keys are rejected, which is what excludes byte-carrying shapes (Blob/File/
 * ArrayBuffer/typed arrays/base64/data URLs/file or temporary playback URIs).
 * Journal prose or transcripts that merely contain a data-URL-like string are
 * untouched — we never sniff field content.
 */
import type {
  JournalEntry,
  JournalMedia,
  JournalMediaKind,
  JournalSnapshotV1,
  TranscriptionStatus,
} from '@/types/journal';
import { isValidIsoDate, isValidIsoTimestamp } from '@/features/plans/planDates';

/** Distinct key from the web planner's browser-storage key. */
export const JOURNAL_STORAGE_KEY = 'workazy-native-journal-v1';

export type JournalStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type JournalParseResult =
  | { ok: true; snapshot: JournalSnapshotV1 }
  | { ok: false; error: string };

const MEDIA_KINDS: readonly JournalMediaKind[] = ['audio', 'video'];

const TRANSCRIPTION_STATUSES: readonly TranscriptionStatus[] = [
  'pending',
  'processing',
  'ready',
  'error',
];

/** Explicit attachment metadata schema — anything else is a structural error. */
const MEDIA_KEYS: readonly string[] = [
  'id',
  'journalEntryId',
  'type',
  'mimeType',
  'originalFilename',
  'sizeBytes',
  'durationMs',
  'width',
  'height',
  'transcript',
  'transcriptEdited',
  'transcriptionStatus',
  'transcriptionError',
  'transcriptionProvider',
  'createdAt',
  'updatedAt',
];

/** Deep copy so subscribers cannot mutate committed state (arrays + media). */
export function cloneEntries(entries: readonly JournalEntry[]): JournalEntry[] {
  return entries.map((entry) => {
    const copy: JournalEntry = { ...entry, tags: [...entry.tags] };
    if (entry.media !== undefined) {
      copy.media = entry.media.map((media) => ({ ...media }));
    }
    return copy;
  });
}

/**
 * Deep-freeze copy for the PUBLISHED store state: rows, the tags array, the
 * media array and every media object (nested transcription fields included) are
 * frozen, so an external mutation of a returned snapshot cannot change committed
 * state, notify subscribers, or leak into a later write. The frozen structure is
 * still a stable reference (required by `useSyncExternalStore`).
 */
export function deepFreezeEntries(
  entries: readonly JournalEntry[],
): readonly JournalEntry[] {
  const rows = entries.map((entry) => {
    const tags = Object.freeze([...entry.tags]) as unknown as string[];
    const copy: JournalEntry = { ...entry, tags };
    if (entry.media !== undefined) {
      copy.media = Object.freeze(entry.media.map((media) => Object.freeze({ ...media }))) as
        unknown as JournalMedia[];
    }
    return Object.freeze(copy);
  });
  return Object.freeze(rows);
}

export function serializeSnapshot(
  entries: readonly JournalEntry[],
  savedAt: string,
): string {
  const snapshot: JournalSnapshotV1 = {
    version: 1,
    entries: cloneEntries(entries),
    savedAt,
  };
  return JSON.stringify(snapshot);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function parseMedia(
  raw: unknown,
  entryId: string,
  seenMediaIds: Set<string>,
): { ok: true; media: JournalMedia } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'media-not-object' };
  }
  const item = raw as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    if (!MEDIA_KEYS.includes(key)) return { ok: false, error: `media-unknown-key:${key}` };
  }
  if (typeof item.id !== 'string' || item.id.length === 0) {
    return { ok: false, error: 'bad-media-id' };
  }
  if (seenMediaIds.has(item.id)) return { ok: false, error: 'duplicate-media-id' };
  seenMediaIds.add(item.id);
  if (item.journalEntryId !== entryId) return { ok: false, error: 'media-entry-mismatch' };
  if (!MEDIA_KINDS.includes(item.type as JournalMediaKind)) {
    return { ok: false, error: 'bad-media-type' };
  }
  if (typeof item.mimeType !== 'string' || item.mimeType.length === 0) {
    return { ok: false, error: 'bad-media-mime' };
  }
  if (!optionalString(item.originalFilename)) {
    return { ok: false, error: 'bad-media-filename' };
  }
  if (
    typeof item.sizeBytes !== 'number' ||
    !Number.isFinite(item.sizeBytes) ||
    item.sizeBytes < 0
  ) {
    return { ok: false, error: 'bad-media-size' };
  }
  for (const [key, value] of [
    ['durationMs', item.durationMs],
    ['width', item.width],
    ['height', item.height],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return { ok: false, error: `bad-media-${key}` };
    }
  }
  if (!optionalString(item.transcript)) return { ok: false, error: 'bad-media-transcript' };
  if (typeof item.transcriptEdited !== 'boolean') {
    return { ok: false, error: 'bad-media-transcript-edited' };
  }
  if (
    typeof item.transcriptionStatus !== 'string' ||
    !TRANSCRIPTION_STATUSES.includes(item.transcriptionStatus as TranscriptionStatus)
  ) {
    return { ok: false, error: 'bad-media-transcription-status' };
  }
  if (!optionalString(item.transcriptionError)) {
    return { ok: false, error: 'bad-media-transcription-error' };
  }
  if (!optionalString(item.transcriptionProvider)) {
    return { ok: false, error: 'bad-media-transcription-provider' };
  }
  if (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt)) {
    return { ok: false, error: 'bad-media-created-at' };
  }
  if (typeof item.updatedAt !== 'string' || !isValidIsoTimestamp(item.updatedAt)) {
    return { ok: false, error: 'bad-media-updated-at' };
  }

  const media: JournalMedia = {
    id: item.id,
    journalEntryId: entryId,
    type: item.type as JournalMediaKind,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    transcriptEdited: item.transcriptEdited,
    transcriptionStatus: item.transcriptionStatus as TranscriptionStatus,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (item.originalFilename !== undefined) {
    media.originalFilename = item.originalFilename as string;
  }
  if (item.durationMs !== undefined) media.durationMs = item.durationMs as number;
  if (item.width !== undefined) media.width = item.width as number;
  if (item.height !== undefined) media.height = item.height as number;
  if (item.transcript !== undefined) media.transcript = item.transcript as string;
  if (item.transcriptionError !== undefined) {
    media.transcriptionError = item.transcriptionError as string;
  }
  if (item.transcriptionProvider !== undefined) {
    media.transcriptionProvider = item.transcriptionProvider as string;
  }
  return { ok: true, media };
}

export function parseSnapshot(raw: string): JournalParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not-object' };
  }
  const object = parsed as Record<string, unknown>;
  if (object.version !== 1) return { ok: false, error: 'unknown-version' };
  if (!Array.isArray(object.entries)) return { ok: false, error: 'entries-not-array' };
  if (typeof object.savedAt !== 'string' || !isValidIsoTimestamp(object.savedAt)) {
    return { ok: false, error: 'bad-saved-at' };
  }

  const entries: JournalEntry[] = [];
  const seenEntryIds = new Set<string>();
  const seenMediaIds = new Set<string>();
  for (const rawEntry of object.entries) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return { ok: false, error: 'entry-not-object' };
    }
    const item = rawEntry as Record<string, unknown>;
    if (typeof item.id !== 'string' || item.id.length === 0) {
      return { ok: false, error: 'bad-entry-id' };
    }
    if (seenEntryIds.has(item.id)) return { ok: false, error: 'duplicate-entry-id' };
    seenEntryIds.add(item.id);
    if (typeof item.date !== 'string' || !isValidIsoDate(item.date)) {
      return { ok: false, error: 'bad-entry-date' };
    }
    if (!optionalString(item.title)) return { ok: false, error: 'bad-entry-title' };
    if (typeof item.body !== 'string') return { ok: false, error: 'bad-entry-body' };
    if (!optionalString(item.mood)) return { ok: false, error: 'bad-entry-mood' };
    if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string')) {
      return { ok: false, error: 'bad-entry-tags' };
    }
    if (
      item.createdAt !== undefined &&
      (typeof item.createdAt !== 'string' || !isValidIsoTimestamp(item.createdAt))
    ) {
      return { ok: false, error: 'bad-entry-created-at' };
    }
    if (
      item.updatedAt !== undefined &&
      (typeof item.updatedAt !== 'string' || !isValidIsoTimestamp(item.updatedAt))
    ) {
      return { ok: false, error: 'bad-entry-updated-at' };
    }

    const entry: JournalEntry = {
      id: item.id,
      date: item.date,
      body: item.body,
      tags: [...(item.tags as string[])],
    };
    if (item.title !== undefined) entry.title = item.title as string;
    if (item.mood !== undefined) entry.mood = item.mood as string;
    if (item.createdAt !== undefined) entry.createdAt = item.createdAt as string;
    if (item.updatedAt !== undefined) entry.updatedAt = item.updatedAt as string;

    if (item.media !== undefined) {
      if (!Array.isArray(item.media)) return { ok: false, error: 'media-not-array' };
      const media: JournalMedia[] = [];
      for (const rawMedia of item.media) {
        const result = parseMedia(rawMedia, entry.id, seenMediaIds);
        if (!result.ok) return { ok: false, error: result.error };
        media.push(result.media);
      }
      entry.media = media;
    }
    entries.push(entry);
  }

  return {
    ok: true,
    snapshot: { version: 1, entries, savedAt: object.savedAt },
  };
}
