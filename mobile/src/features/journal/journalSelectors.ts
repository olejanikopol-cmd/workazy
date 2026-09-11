/**
 * Pure journal selectors: history order, local search, row previews.
 *
 * Ordering never rewrites storage — it derives a display list only:
 * date descending, then `createdAt` descending (rows WITHOUT createdAt sort
 * after rows with one for the same date), then the original stored index for
 * ties. New rows prepend, edits keep their stored position, and `updatedAt`
 * never reorders History.
 *
 * Search is local and case-insensitive across title, body, mood, tags and
 * existing media transcripts (conceptually matching the web `entrySearchText`).
 */
import type { JournalEntry } from '@/types/journal';

/** Mood chips — exact product values; storage stays an optional string. */
export const MOOD_CHOICES = ['Спокойно', 'Энергично', 'Тяжело', 'Радостно'] as const;

const PREVIEW_MAX_LENGTH = 160;

/** Display order for History; returns a new array, never mutates storage. */
export function historyOrder(entries: readonly JournalEntry[]): JournalEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? 1 : -1;
      const left = a.entry.createdAt;
      const right = b.entry.createdAt;
      if (left !== right) {
        if (left === undefined) return 1; // missing createdAt sorts after present
        if (right === undefined) return -1;
        return left < right ? 1 : -1;
      }
      return a.index - b.index; // stable: original stored position wins ties
    })
    .map((item) => item.entry);
}

/** Searchable text mirroring the web search provenance, plus the mood. */
export function entrySearchText(entry: JournalEntry): string {
  const transcripts = (entry.media ?? []).map((media) => media.transcript ?? '').join(' ');
  return [entry.title ?? '', entry.body, entry.mood ?? '', entry.tags.join(' '), transcripts].join(
    ' ',
  );
}

/** Local case-insensitive search; an empty query returns everything. */
export function searchEntries(
  entries: readonly JournalEntry[],
  query: string,
): JournalEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...entries];
  return entries.filter((entry) => entrySearchText(entry).toLowerCase().includes(needle));
}

/** Single-line preview for rows (display only; the reader shows the real body). */
export function entryPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PREVIEW_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, PREVIEW_MAX_LENGTH).trimEnd()}…`;
}

/** Display fallback only — storage keeps an absent title absent. */
export function entryDisplayTitle(entry: JournalEntry, fallback: string): string {
  const title = entry.title?.trim();
  return title && title.length > 0 ? title : fallback;
}

/** Row summary: mood + tags, never fabricated. */
export function entryMeta(entry: JournalEntry): string {
  const parts: string[] = [];
  if (entry.mood !== undefined && entry.mood.trim().length > 0) parts.push(entry.mood);
  if (entry.tags.length > 0) parts.push(entry.tags.map((tag) => `#${tag}`).join(' '));
  if ((entry.media ?? []).length > 0) parts.push('Вложения');
  return parts.join(' · ');
}
