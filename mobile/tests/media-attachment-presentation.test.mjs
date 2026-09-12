import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSCRIPT_PREVIEW_CHARS,
  describeTranscript,
} from '../src/services/media/attachmentPresentation.ts';

const base = { transcriptionStatus: 'pending' };

test('an attachment with a transcript exposes the FULL stored text', () => {
  const long = 'я'.repeat(TRANSCRIPT_PREVIEW_CHARS + 250);
  const described = describeTranscript({
    transcript: long,
    transcriptEdited: false,
    transcriptionStatus: 'ready',
  });
  assert.equal(described.text, long); // never truncated by the policy
  assert.equal(described.text.length, long.length);
  assert.equal(described.collapsible, true); // the DISPLAY may collapse it
  assert.equal(described.note, null);

  const short = describeTranscript({
    transcript: 'Короткая расшифровка',
    transcriptEdited: false,
    transcriptionStatus: 'ready',
  });
  assert.equal(short.text, 'Короткая расшифровка');
  assert.equal(short.collapsible, false);
});

test('an attachment without a transcript renders no fake content', () => {
  const described = describeTranscript({ ...base });
  assert.equal(described.text, null);
  assert.equal(described.collapsible, false);
  // 'ready' without text must not invent text either.
  const readyWithoutText = describeTranscript({ transcriptionStatus: 'ready' });
  assert.equal(readyWithoutText.text, null);
  assert.equal(readyWithoutText.note, null);
  // Whitespace-only transcripts are not content.
  const blank = describeTranscript({ transcript: '   ', transcriptionStatus: 'pending' });
  assert.equal(blank.text, null);
});

test('existing transcript metadata is described honestly (no cloud claims)', () => {
  const pending = describeTranscript({ ...base });
  assert.equal(pending.note, 'Расшифровка пока недоступна');
  const processing = describeTranscript({ transcriptionStatus: 'processing' });
  assert.equal(processing.note, 'Расшифровка пока недоступна');
  const failed = describeTranscript({ transcriptionStatus: 'error' });
  assert.equal(failed.note, 'Расшифровка не удалась');
  const failedWithReason = describeTranscript({
    transcriptionStatus: 'error',
    transcriptionError: 'unsupported audio track',
  });
  assert.equal(failedWithReason.note, 'Расшифровка не удалась: unsupported audio track');
});

test('a transcript that exists is shown even when the status is not ready', () => {
  const described = describeTranscript({
    transcript: 'Текст есть',
    transcriptionStatus: 'error',
    transcriptEdited: true,
  });
  assert.equal(described.text, 'Текст есть'); // read-only display, no reinterpretation
  assert.equal(described.note, null);
});
