/**
 * Native journal media limits and MIME helpers.
 *
 * Provenance: mirrored from repository `lib/media-limits.ts` (web client +
 * server use the same per-file limits). Native code only produces AAC/M4A audio
 * and MP4/MOV video, but the MIME lists and helpers are mirrored so validation
 * stays compatible with files already recorded by the web client.
 *
 * These are PER-FILE limits. They are not decimal MB values and there is no
 * aggregate per-entry cap.
 */
export type MediaKind = 'audio' | 'video';

/** 15 minutes. */
export const MAX_AUDIO_DURATION_MS = 900_000;
/** 10 minutes. */
export const MAX_VIDEO_DURATION_MS = 600_000;
/** 24 MiB (24 * 1024 * 1024). */
export const MAX_AUDIO_SIZE_BYTES = 25_165_824;
/** 80 MiB (80 * 1024 * 1024). */
export const MAX_VIDEO_SIZE_BYTES = 83_886_080;
/** Existing web target for personal journal video. */
export const VIDEO_BITS_PER_SECOND = 900_000;
/** Existing web target for voice recordings. */
export const AUDIO_BITS_PER_SECOND = 96_000;

export const AUDIO_MIME_TYPES = [
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/mpeg',
  'audio/wav',
] as const;

export const VIDEO_MIME_TYPES = ['video/webm', 'video/mp4', 'video/quicktime'] as const;

/** MIME values a NATIVE capture can actually produce in this slice. */
export const NATIVE_AUDIO_MIME_TYPES = ['audio/mp4', 'audio/x-m4a'] as const;
export const NATIVE_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** Trim parameters and lowercase, like the web `normalizeMime`. */
export function normalizeMime(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/** MIME for a container extension (native capture adoption only). */
const MIME_BY_EXTENSION: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export function mimeForExtension(extension: string): string | null {
  const normalized = extension.toLowerCase().replace(/^\./, '');
  return MIME_BY_EXTENSION[normalized] ?? null;
}

/** Extension that follows from the ACTUAL MIME (never a forced rename). */
export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[normalizeMime(mimeType)] ?? 'bin';
}

export function isAudioMime(mimeType: string): boolean {
  return (AUDIO_MIME_TYPES as readonly string[]).includes(normalizeMime(mimeType));
}

export function isVideoMime(mimeType: string): boolean {
  return (VIDEO_MIME_TYPES as readonly string[]).includes(normalizeMime(mimeType));
}

export function isMimeAllowedForKind(kind: MediaKind, mimeType: string): boolean {
  return kind === 'audio' ? isAudioMime(mimeType) : isVideoMime(mimeType);
}

/** True when a native capture of `kind` may claim this MIME. */
export function isNativeMimeForKind(kind: MediaKind, mimeType: string): boolean {
  const list: readonly string[] = kind === 'audio' ? NATIVE_AUDIO_MIME_TYPES : NATIVE_VIDEO_MIME_TYPES;
  return list.includes(normalizeMime(mimeType));
}

/** The exact syntax accepted for an extension derived from the container. */
export function isExpectedExtension(kind: MediaKind, extension: string): boolean {
  const allowed = kind === 'audio' ? ['m4a', 'mp4'] : ['mp4', 'mov'];
  return allowed.includes(extension.toLowerCase().replace(/^\./, ''));
}

export function limitsFor(kind: MediaKind): { maxDurationMs: number; maxSizeBytes: number } {
  return kind === 'audio'
    ? { maxDurationMs: MAX_AUDIO_DURATION_MS, maxSizeBytes: MAX_AUDIO_SIZE_BYTES }
    : { maxDurationMs: MAX_VIDEO_DURATION_MS, maxSizeBytes: MAX_VIDEO_SIZE_BYTES };
}

export type CaptureMetadataReason =
  | 'size-invalid'
  | 'size-too-large'
  | 'duration-invalid'
  | 'duration-too-long'
  | 'mime-unsupported';

export type CaptureValidation =
  | { ok: true }
  | { ok: false; reason: CaptureMetadataReason };

/**
 * Validate the FINALIZED file metadata of a capture against the per-file
 * limits. Unknown/zero/negative/non-finite values are errors — never a
 * fabricated success and never a silent truncation.
 */
export function validateCaptureMetadata(
  kind: MediaKind,
  input: { sizeBytes: number | null; durationMs: number | null; mimeType: string | null },
): CaptureValidation {
  if (input.mimeType === null || !normalizeMime(input.mimeType) || !isMimeAllowedForKind(kind, input.mimeType)) {
    return { ok: false, reason: 'mime-unsupported' };
  }
  const { maxDurationMs, maxSizeBytes } = limitsFor(kind);
  if (
    input.sizeBytes === null ||
    !Number.isFinite(input.sizeBytes) ||
    input.sizeBytes <= 0
  ) {
    return { ok: false, reason: 'size-invalid' };
  }
  if (input.sizeBytes > maxSizeBytes) return { ok: false, reason: 'size-too-large' };
  if (
    input.durationMs === null ||
    !Number.isFinite(input.durationMs) ||
    input.durationMs <= 0
  ) {
    return { ok: false, reason: 'duration-invalid' };
  }
  if (input.durationMs > maxDurationMs) return { ok: false, reason: 'duration-too-long' };
  return { ok: true };
}

/** Seconds for a native `forDuration`/`maxDuration` option. */
export function maxDurationSeconds(kind: MediaKind): number {
  return limitsFor(kind).maxDurationMs / 1000;
}

/** Human duration, e.g. «1:05»; empty for unknown/invalid input. */
export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return '';
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Human file size, e.g. «512 КБ» / «1.4 МБ». */
export function formatFileSize(sizeBytes: number | null | undefined): string {
  if (sizeBytes === null || sizeBytes === undefined) return '';
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 КБ';
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} КБ`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}
