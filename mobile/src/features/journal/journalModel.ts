/**
 * Pure journal mutations, validation and selectors.
 *
 * One stored array holds every entry (new rows prepend). Mutations take/return
 * discarded arrays and never mutate their input. Editing preserves the id, the
 * stored array position, the captured local date, `createdAt` (including its
 * ABSENCE on legacy rows) and all attachment metadata; only the fields the user
 * actually changed (plus `updatedAt`) are rewritten. Untouched stored tags are
 * preserved verbatim — including legacy long arrays and tokens containing
 * commas — because the raw tag input is passed through unchanged.
 *
 * Input rules are explicit and visible (no TextInput truncation):
 * - title: optional, outer trim, blank -> omitted, max 300 for new/changed values;
 * - body: outer trim, every internal newline/blank line/emoji/space preserved,
 *   NO application length cap (the 5,000-character limit is a transport cap, not
 *   a local one; long local entries are protected from loss);
 * - mood: optional string, blank -> unset, max 60 for changed values;
 * - tags: comma-separated, each token trimmed, empties omitted, case/order/
 *   duplicates preserved, max 20 tags × 40 characters for changed values.
 */
import type { JournalEntry, JournalMedia } from '@/types/journal';
import {
  isSafeMediaId,
} from '@/storage/localMediaManifest';
import {
  normalizeMime,
  validateCaptureMetadata,
} from '@/services/media/mediaLimits';
import { isSupportedRecordsDate } from '../records/recordsDates';

export const JOURNAL_TITLE_MAX_LENGTH = 300;
export const JOURNAL_MOOD_MAX_LENGTH = 60;
export const JOURNAL_TAG_MAX_COUNT = 20;
export const JOURNAL_TAG_MAX_LENGTH = 40;

export type JournalValidationReason =
  | 'validation'
  | 'missing'
  | 'date-invalid'
  | 'body-blank'
  | 'title-too-long'
  | 'mood-too-long'
  | 'tags-too-many'
  | 'tag-too-long'
  | 'media-id-invalid'
  | 'media-type-invalid'
  | 'media-too-large'
  | 'media-duration-too-long'
  | 'media-invalid'
  | 'media-duplicate'
  | 'media-missing';

export type JournalValidationFailure = { ok: false; reason: JournalValidationReason };

export type JournalEntriesResult =
  | { ok: true; entries: readonly JournalEntry[] }
  | JournalValidationFailure;

export type JournalAddResult =
  | { ok: true; entries: readonly JournalEntry[]; entry: JournalEntry }
  | JournalValidationFailure;


/**
 * Which editor fields the user actually changed. Only changed fields are
 * validated/normalized; untouched committed values are preserved exactly
 * (legacy overlength values, present-but-empty optionals and raw whitespace
 * included) so an unrelated edit never rewrites them.
 */
export type JournalFieldChanges = {
  title: boolean;
  body: boolean;
  mood: boolean;
  tags: boolean;
};

/** Raw editor values + the per-field change flags. */
export type JournalEntryInput = {
  title: string;
  body: string;
  mood: string;
  tags: string;
  changed: JournalFieldChanges;
};

const ALL_JOURNAL_FIELDS: JournalFieldChanges = {
  title: true,
  body: true,
  mood: true,
  tags: true,
};

export type AddJournalInput = JournalEntryInput & {
  id: string;
  date: string;
  now: Date;
};

function trimmedOrUndefined(raw: string): string | undefined {
  const value = raw.trim();
  return value.length === 0 ? undefined : value;
}

/** Parse the comma-separated tag input (trim tokens, drop empties, keep order). */
export function parseTagInput(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function validateTitle(raw: string): { ok: true; title?: string } | { ok: false } {
  const title = trimmedOrUndefined(raw);
  if (title !== undefined && title.length > JOURNAL_TITLE_MAX_LENGTH) return { ok: false };
  return title === undefined ? { ok: true } : { ok: true, title };
}

export function validateMood(raw: string): { ok: true; mood?: string } | { ok: false } {
  const mood = trimmedOrUndefined(raw);
  if (mood !== undefined && mood.length > JOURNAL_MOOD_MAX_LENGTH) return { ok: false };
  return mood === undefined ? { ok: true } : { ok: true, mood };
}

export function validateTags(
  tags: readonly string[],
): { ok: true; tags: string[] } | { ok: false } {
  if (tags.length > JOURNAL_TAG_MAX_COUNT) return { ok: false };
  if (tags.some((tag) => tag.length > JOURNAL_TAG_MAX_LENGTH)) return { ok: false };
  return { ok: true, tags: [...tags] };
}

/** Body rule: outer trim, internal text untouched, nonblank for text-only rows. */
export function normalizeBody(raw: string): string {
  return raw.trim();
}

/**
 * Build the row fields. `forceAll` is used for a NEW entry (everything is a
 * changed value); for an edit only the flagged fields are validated and
 * normalized — everything else is copied from the committed row verbatim, so a
 * legacy title above the input limit cannot block a body-only edit and an
 * untouched body keeps its exact whitespace.
 */
function buildFields(
  input: JournalEntryInput,
  existing: JournalEntry | undefined,
  forceAll: boolean,
):
  | { ok: true; title?: string; body: string; mood?: string; tags: string[] }
  | JournalValidationFailure {
  const changed = forceAll ? ALL_JOURNAL_FIELDS : input.changed;

  let title: string | undefined = existing?.title;
  if (changed.title || existing === undefined) {
    const validated = validateTitle(input.title);
    if (!validated.ok) return { ok: false, reason: 'title-too-long' };
    title = validated.title;
  }

  let mood: string | undefined = existing?.mood;
  if (changed.mood || existing === undefined) {
    const validated = validateMood(input.mood);
    if (!validated.ok) return { ok: false, reason: 'mood-too-long' };
    mood = validated.mood;
  }

  const body =
    changed.body || existing === undefined ? normalizeBody(input.body) : existing.body;

  // Untouched tags keep the stored value exactly (legacy arrays included).
  let tags: string[];
  if (changed.tags || existing === undefined) {
    const tagInput = parseTagInput(input.tags);
    const validated = validateTags(tagInput);
    if (!validated.ok) {
      return {
        ok: false,
        reason: tagInput.length > JOURNAL_TAG_MAX_COUNT ? 'tags-too-many' : 'tag-too-long',
      };
    }
    tags = validated.tags;
  } else {
    tags = [...existing.tags];
  }

  return { ok: true, title, body, mood, tags };
}

/**
 * Prepend a new entry for a captured local date. A text-only entry requires a
 * nonblank body: title/mood/tags alone cannot create an empty row. `createdAt`
 * and `updatedAt` share the same canonical UTC instant.
 */
export function addEntry(
  entries: readonly JournalEntry[],
  input: AddJournalInput,
): JournalAddResult {
  if (!isSupportedRecordsDate(input.date)) return { ok: false, reason: 'date-invalid' };
  const fields = buildFields(input, undefined, true);
  if (!fields.ok) return fields;
  if (fields.body.length === 0) return { ok: false, reason: 'body-blank' };
  const nowIso = input.now.toISOString();
  const entry: JournalEntry = {
    id: input.id,
    date: input.date,
    body: fields.body,
    tags: fields.tags,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (fields.title !== undefined) entry.title = fields.title;
  if (fields.mood !== undefined) entry.mood = fields.mood;
  return { ok: true, entries: [entry, ...entries], entry };
}

/**
 * Edit one entry in place: id/date/createdAt/position/media (and untouched tags)
 * are preserved exactly; an entry that HAS attachments may keep an empty body,
 * a text-only entry may not be cleared.
 */
export function editEntry(
  entries: readonly JournalEntry[],
  id: string,
  input: JournalEntryInput,
  now: Date,
): JournalEntriesResult {
  const existing = entries.find((entry) => entry.id === id);
  if (!existing) return { ok: false, reason: 'missing' };
  const fields = buildFields(input, existing, false);
  if (!fields.ok) return fields;
  const hasMedia = (existing.media ?? []).length > 0;
  if (fields.body.length === 0 && !hasMedia) return { ok: false, reason: 'body-blank' };

  // Start from the committed row (id/date/createdAt/media/order and any
  // untouched optional value survive) and apply ONLY the changed fields.
  const next: JournalEntry = {
    ...existing,
    body: fields.body,
    tags: fields.tags,
    updatedAt: now.toISOString(),
  };
  if (input.changed.title) {
    if (fields.title === undefined) delete next.title;
    else next.title = fields.title;
  }
  if (input.changed.mood) {
    if (fields.mood === undefined) delete next.mood;
    else next.mood = fields.mood;
  }
  return { ok: true, entries: entries.map((entry) => (entry.id === id ? next : entry)) };
}

/** Local-only removal. Attachment metadata disappears with the row; nothing remote. */
export function removeEntry(entries: readonly JournalEntry[], id: string): JournalEntriesResult {
  if (!entries.some((entry) => entry.id === id)) return { ok: false, reason: 'missing' };
  return { ok: true, entries: entries.filter((entry) => entry.id !== id) };
}

// ---------------------------------------------------------------------------
// Attachment (metadata-only) support
// ---------------------------------------------------------------------------

/** Metadata for a prepared local attachment; the store supplies the parent id. */
export type JournalMediaAttachmentInput = {
  id: string;
  type: 'audio' | 'video';
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  width?: number;
  height?: number;
  originalFilename?: string;
};

export type AddEntryWithMediaInput = JournalEntryInput & {
  id: string;
  date: string;
  now: Date;
  media: readonly JournalMediaAttachmentInput[];
};

export type EditEntryMediaChange = {
  add?: readonly JournalMediaAttachmentInput[];
  removeIds?: readonly string[];
};

function allMediaIds(entries: readonly JournalEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const media of entry.media ?? []) ids.add(media.id);
  }
  return ids;
}

/** Validate one prepared attachment against the mirrored per-file limits. */
function validateAttachment(
  attachment: JournalMediaAttachmentInput,
): { ok: true } | { ok: false; reason: JournalValidationReason } {
  if (!isSafeMediaId(attachment.id)) return { ok: false, reason: 'media-id-invalid' };
  if (attachment.type !== 'audio' && attachment.type !== 'video') {
    return { ok: false, reason: 'media-type-invalid' };
  }
  const validated = validateCaptureMetadata(attachment.type, {
    sizeBytes: attachment.sizeBytes,
    durationMs: attachment.durationMs ?? null,
    mimeType: attachment.mimeType,
  });
  if (!validated.ok) {
    switch (validated.reason) {
      case 'size-too-large':
        return { ok: false, reason: 'media-too-large' };
      case 'duration-too-long':
        return { ok: false, reason: 'media-duration-too-long' };
      case 'mime-unsupported':
        return { ok: false, reason: 'media-type-invalid' };
      default:
        return { ok: false, reason: 'media-invalid' };
    }
  }
  return { ok: true };
}

/** Build the persisted metadata for a validated attachment of `entryId`. */
function buildMedia(
  attachment: JournalMediaAttachmentInput,
  entryId: string,
  nowIso: string,
): JournalMedia {
  const media: JournalMedia = {
    id: attachment.id,
    journalEntryId: entryId,
    type: attachment.type,
    mimeType: normalizeMime(attachment.mimeType),
    sizeBytes: attachment.sizeBytes,
    transcriptEdited: false,
    // "pending" = not transcribed in the current web model; there is no queue.
    transcriptionStatus: 'pending',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (attachment.durationMs !== undefined) media.durationMs = attachment.durationMs;
  if (attachment.width !== undefined) media.width = attachment.width;
  if (attachment.height !== undefined) media.height = attachment.height;
  if (attachment.originalFilename !== undefined) {
    media.originalFilename = attachment.originalFilename;
  }
  return media;
}

/**
 * Prepend a new entry together with all prepared attachments in ONE row.
 * A media-only entry is valid (at least one real prepared attachment); a blank
 * TEXT-ONLY entry is not. Attachment ids must be unique across every entry.
 */
export function addEntryWithMedia(
  entries: readonly JournalEntry[],
  input: AddEntryWithMediaInput,
): JournalAddResult {
  if (!isSupportedRecordsDate(input.date)) return { ok: false, reason: 'date-invalid' };
  const fields = buildFields(input, undefined, true);
  if (!fields.ok) return fields;
  if (input.media.length === 0 && fields.body.length === 0) {
    return { ok: false, reason: 'body-blank' };
  }

  const existingIds = allMediaIds(entries);
  const seen = new Set<string>();
  for (const attachment of input.media) {
    const validated = validateAttachment(attachment);
    if (!validated.ok) return validated;
    if (existingIds.has(attachment.id) || seen.has(attachment.id)) {
      return { ok: false, reason: 'media-duplicate' };
    }
    seen.add(attachment.id);
  }

  const nowIso = input.now.toISOString();
  const entry: JournalEntry = {
    id: input.id,
    date: input.date,
    body: fields.body,
    tags: fields.tags,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (fields.title !== undefined) entry.title = fields.title;
  if (fields.mood !== undefined) entry.mood = fields.mood;
  if (input.media.length > 0) {
    entry.media = input.media.map((attachment) => buildMedia(attachment, entry.id, nowIso));
  }
  return { ok: true, entries: [entry, ...entries], entry };
}

/**
 * Merge attachment additions/removals into the LATEST committed row. Kept media
 * (metadata and order) and every untouched text field are preserved exactly; a
 * removal may leave an empty body (legacy/media-compatible) as long as the row
 * still has media or already had a body.
 */
export function editEntryWithMedia(
  entries: readonly JournalEntry[],
  id: string,
  input: JournalEntryInput,
  change: EditEntryMediaChange,
  now: Date,
): JournalEntriesResult {
  const existing = entries.find((entry) => entry.id === id);
  if (!existing) return { ok: false, reason: 'missing' };
  const add = change.add ?? [];
  const removeIds = change.removeIds ?? [];

  const keptMedia = (existing.media ?? []).filter((media) => !removeIds.includes(media.id));
  const knownIds = allMediaIds(entries);
  const seen = new Set<string>();
  for (const attachment of add) {
    const validated = validateAttachment(attachment);
    if (!validated.ok) return validated;
    if (knownIds.has(attachment.id) || seen.has(attachment.id)) {
      return { ok: false, reason: 'media-duplicate' };
    }
    seen.add(attachment.id);
  }
  for (const mediaId of removeIds) {
    if (!(existing.media ?? []).some((media) => media.id === mediaId)) {
      return { ok: false, reason: 'media-missing' };
    }
  }

  const fields = buildFields(input, existing, false);
  if (!fields.ok) return fields;
  const nowIso = now.toISOString();
  const nextMedia = [
    ...keptMedia,
    ...add.map((attachment) => buildMedia(attachment, existing.id, nowIso)),
  ];
  if (fields.body.length === 0 && nextMedia.length === 0) {
    return { ok: false, reason: 'body-blank' };
  }

  const next: JournalEntry = {
    ...existing,
    body: fields.body,
    tags: fields.tags,
    updatedAt: nowIso,
  };
  if (input.changed.title) {
    if (fields.title === undefined) delete next.title;
    else next.title = fields.title;
  }
  if (input.changed.mood) {
    if (fields.mood === undefined) delete next.mood;
    else next.mood = fields.mood;
  }
  if (nextMedia.length > 0) next.media = nextMedia;
  else delete next.media;
  return { ok: true, entries: entries.map((entry) => (entry.id === id ? next : entry)) };
}

/** Remove one attachment from a committed entry (reader action). */
export function removeEntryMedia(
  entries: readonly JournalEntry[],
  entryId: string,
  mediaId: string,
  now: Date,
): JournalEntriesResult {
  const existing = entries.find((entry) => entry.id === entryId);
  if (!existing) return { ok: false, reason: 'missing' };
  if (!(existing.media ?? []).some((media) => media.id === mediaId)) {
    return { ok: false, reason: 'media-missing' };
  }
  const remaining = (existing.media ?? []).filter((media) => media.id !== mediaId);
  const next: JournalEntry = { ...existing, updatedAt: now.toISOString() };
  if (remaining.length > 0) next.media = remaining;
  else delete next.media;
  return { ok: true, entries: entries.map((entry) => (entry.id === entryId ? next : entry)) };
}
