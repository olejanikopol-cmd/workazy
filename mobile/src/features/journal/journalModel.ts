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
import type { JournalEntry } from '@/types/journal';
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
  | 'tag-too-long';

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
