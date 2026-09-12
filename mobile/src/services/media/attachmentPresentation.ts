/**
 * Attachment presentation policy: what the card may show about an attachment's
 * transcript metadata. Read-only — no transcription execution, upload or editing.
 *
 * The stored transcript text is never truncated here: the UI may collapse the
 * DISPLAY behind an explicit "show more" control, but the data itself is intact.
 */
import type { JournalMedia } from '@/types/journal';

/** Display threshold for offering the expand control (not a data truncation). */
export const TRANSCRIPT_PREVIEW_CHARS = 600;

export type TranscriptPresentation = {
  /** Full stored transcript text (null when the attachment has none). */
  text: string | null;
  /** Honest note about the existing transcript metadata (never invented). */
  note: string | null;
  /** True when the display should offer an expand/collapse control. */
  collapsible: boolean;
};

export function describeTranscript(
  media: Pick<
    JournalMedia,
    'transcript' | 'transcriptionStatus' | 'transcriptEdited' | 'transcriptionError'
  >,
): TranscriptPresentation {
  const text = media.transcript?.trim() ?? '';
  if (text.length > 0) {
    return {
      text: media.transcript as string,
      note: null,
      collapsible: text.length > TRANSCRIPT_PREVIEW_CHARS,
    };
  }
  switch (media.transcriptionStatus) {
    case 'error':
      return {
        text: null,
        note:
          media.transcriptionError !== undefined && media.transcriptionError.trim().length > 0
            ? `Расшифровка не удалась: ${media.transcriptionError.trim()}`
            : 'Расшифровка не удалась',
        collapsible: false,
      };
    case 'pending':
    case 'processing':
      return {
        text: null,
        // The local branch never transcribes: no queue, no spinner, no promise.
        note: 'Расшифровка пока недоступна',
        collapsible: false,
      };
    default:
      // 'ready' without text: show nothing rather than inventing content.
      return { text: null, note: null, collapsible: false };
  }
}
