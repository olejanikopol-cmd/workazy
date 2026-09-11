/**
 * Journal domain types for the native app.
 *
 * Compatible with repository `lib/types.ts` (provenance: `JournalEntry`,
 * `JournalMedia`, `JournalMediaKind`, `TranscriptionStatus`); no runtime import
 * from the web app. Mirrors the journal shape only — no merged Record model and
 * no media binary in state.
 *
 * `media` holds attachment METADATA only. Binary audio/video lives in the media
 * backend (R2) in a later slice; Slice 4 never creates, uploads or plays media.
 */
export type JournalMediaKind = 'audio' | 'video';

export type TranscriptionStatus = 'pending' | 'processing' | 'ready' | 'error';

/** Attachment metadata; never carries bytes (no Blob/ArrayBuffer/base64/URI). */
export type JournalMedia = {
  id: string;
  journalEntryId: string;
  type: JournalMediaKind;
  mimeType: string;
  originalFilename?: string;
  sizeBytes: number;
  durationMs?: number;
  width?: number;
  height?: number;
  transcript?: string;
  transcriptEdited: boolean;
  transcriptionStatus: TranscriptionStatus;
  transcriptionError?: string;
  transcriptionProvider?: string;
  createdAt: string;
  updatedAt: string;
};

export type JournalEntry = {
  id: string;
  /** Local calendar date YYYY-MM-DD captured when the editor opened. */
  date: string;
  /** Optional title; blank values are omitted on save. */
  title?: string;
  body: string;
  /** Optional human-readable mood (e.g. «Спокойно»); not an enum. */
  mood?: string;
  tags: string[];
  /** Attachment metadata only; absent for text-only entries. */
  media?: JournalMedia[];
  createdAt?: string;
  updatedAt?: string;
};

/** Persisted envelope under the single native key `workazy-native-journal-v1`. */
export type JournalSnapshotV1 = {
  version: 1;
  entries: JournalEntry[];
  /** ISO timestamp captured for the snapshot write. */
  savedAt: string;
};
