/**
 * Strict V1 filesystem manifest for locally owned journal media.
 *
 * This is an OWNERSHIP record, not another journal store: it proves that the
 * files inside `objects/<mediaId>/` belong to this app and carry the same
 * scalars as the committed journal metadata. Only strict validated scalars are
 * accepted; unknown keys, traversal, separators in IDs/basenames, malformed
 * values and unexpected file types are rejected so an unowned path can never
 * authorize a deletion.
 *
 * `fileName` is the single generated relative basename (`recording.<ext>`);
 * absolute container paths are deliberately NOT stored, because the sandbox
 * root can change between installations/restores.
 */
import { isValidIsoTimestamp } from '@/features/plans/planDates';
import { extensionForMime, normalizeMime } from '@/services/media/mediaLimits';

export const LOCAL_MEDIA_MANIFEST_VERSION = 1;
export const LOCAL_MEDIA_ID_PREFIX = 'local-media-';
export const LOCAL_MEDIA_MANIFEST_FILE = 'manifest.json';

export type LocalMediaManifestV1 = {
  version: 1;
  mediaId: string;
  /** Generated basename only, e.g. `recording.m4a`. */
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  /** Canonical UTC timestamp of the durable promotion. */
  createdAt: string;
};

export type ManifestParseResult =
  | { ok: true; manifest: LocalMediaManifestV1 }
  | { ok: false; error: string };

const MANIFEST_KEYS: readonly string[] = [
  'version',
  'mediaId',
  'fileName',
  'mimeType',
  'sizeBytes',
  'durationMs',
  'createdAt',
];

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FILE_NAME_PATTERN = /^recording\.(m4a|mp4|mov)$/;

const MIME_BY_EXTENSION: Record<string, readonly string[]> = {
  m4a: ['audio/mp4', 'audio/x-m4a'],
  mp4: ['video/mp4'],
  mov: ['video/quicktime'],
};

/** `local-media-<uuid>` only: no separators, no traversal, no prefixes. */
export function isSafeMediaId(id: string): boolean {
  if (typeof id !== 'string' || !id.startsWith(LOCAL_MEDIA_ID_PREFIX)) return false;
  return UUID_PATTERN.test(id.slice(LOCAL_MEDIA_ID_PREFIX.length));
}

/** A generated basename inside the owned object directory. */
export function isSafeMediaFileName(fileName: string): boolean {
  if (typeof fileName !== 'string') return false;
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return false;
  return FILE_NAME_PATTERN.test(fileName);
}

/** The MIME that a manifest may carry for its generated file name. */
export function manifestMimeMatchesFileName(fileName: string, mimeType: string): boolean {
  if (!isSafeMediaFileName(fileName)) return false;
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const allowed = MIME_BY_EXTENSION[extension];
  if (!allowed) return false;
  const normalized = normalizeMime(mimeType);
  if (!allowed.includes(normalized)) return false;
  // The recorded MIME must derive the SAME extension (no forced rename).
  return extensionForMime(normalized) === extension;
}

export function serializeManifest(manifest: LocalMediaManifestV1): string {
  return JSON.stringify({
    version: LOCAL_MEDIA_MANIFEST_VERSION,
    mediaId: manifest.mediaId,
    fileName: manifest.fileName,
    mimeType: manifest.mimeType,
    sizeBytes: manifest.sizeBytes,
    durationMs: manifest.durationMs,
    createdAt: manifest.createdAt,
  });
}

export function parseManifest(raw: string): ManifestParseResult {
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
  for (const key of Object.keys(object)) {
    if (!MANIFEST_KEYS.includes(key)) return { ok: false, error: `unknown-key:${key}` };
  }
  if (object.version !== LOCAL_MEDIA_MANIFEST_VERSION) return { ok: false, error: 'unknown-version' };
  if (typeof object.mediaId !== 'string' || !isSafeMediaId(object.mediaId)) {
    return { ok: false, error: 'bad-media-id' };
  }
  if (typeof object.fileName !== 'string' || !isSafeMediaFileName(object.fileName)) {
    return { ok: false, error: 'bad-file-name' };
  }
  if (typeof object.mimeType !== 'string' || !manifestMimeMatchesFileName(object.fileName, object.mimeType)) {
    return { ok: false, error: 'bad-mime-type' };
  }
  if (
    typeof object.sizeBytes !== 'number' ||
    !Number.isFinite(object.sizeBytes) ||
    !Number.isInteger(object.sizeBytes) ||
    object.sizeBytes <= 0
  ) {
    return { ok: false, error: 'bad-size-bytes' };
  }
  if (
    typeof object.durationMs !== 'number' ||
    !Number.isFinite(object.durationMs) ||
    object.durationMs <= 0
  ) {
    return { ok: false, error: 'bad-duration-ms' };
  }
  if (typeof object.createdAt !== 'string' || !isValidIsoTimestamp(object.createdAt)) {
    return { ok: false, error: 'bad-created-at' };
  }
  return {
    ok: true,
    manifest: {
      version: LOCAL_MEDIA_MANIFEST_VERSION,
      mediaId: object.mediaId,
      fileName: object.fileName,
      mimeType: normalizeMime(object.mimeType),
      sizeBytes: object.sizeBytes,
      durationMs: object.durationMs,
      createdAt: object.createdAt,
    },
  };
}
