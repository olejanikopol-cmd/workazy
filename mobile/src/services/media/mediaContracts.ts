/**
 * Pure media contracts shared by the recorder controller, the local media
 * repository, the journal media coordinator and the UI.
 *
 * Deliberately free of Expo imports: adapters translate native recorder/player/
 * filesystem events into these types, so the policy modules stay unit-testable.
 * No URI or binary ever reaches the journal store — `PreparedLocalMedia` carries
 * METADATA ONLY, exactly like the persisted `JournalMedia` shape.
 */
import type { MediaKind } from './mediaLimits';

/**
 * Sheet-level identity of the editor draft that currently owns media work.
 * Read from the sheet's synchronous state (never captured across awaits).
 */
export type DraftIdentity = {
  /** Sheet identity (parent-owned, synchronously updated). */
  sheetKey: string;
  /** Committed entry id, or null for a new-entry draft. */
  entryId: string | null;
  /** Stable key of a new-entry draft (always present, independent of entryId). */
  draftKey: string;
  /** Monotonic draft revision of the owning editor. */
  draftRevision: number;
};

/** Identity of a capture: the owning draft plus its recorder session. */
export type MediaOwner = DraftIdentity & {
  /** Recorder session id (new per recorder surface activation). */
  sessionId: string;
  /** Operation generation inside one session (cancelled operations are stale). */
  generation: number;
};

export type PermissionStatus = 'granted' | 'denied' | 'undetermined' | 'restricted';

export type PermissionState = {
  status: PermissionStatus;
  /** User can still be asked (not denied-with-cannotAskAgain / restricted). */
  canAskAgain: boolean;
};

/** Result of a successful native capture, before adoption. */
export type CaptureResult = {
  /** Sandbox URI of the freshly finalized native file. */
  uri: string;
  kind: MediaKind;
  /** MIME as reported/derived by the adapter; may be unknown. */
  mimeType: string | null;
  /** Finalized duration; unknown/non-finite values stay null. */
  durationMs: number | null;
  width?: number;
  height?: number;
  /** Optional native-reported size; the repository always re-stats. */
  reportedSizeBytes?: number | null;
};

/** In-memory reference to a take that is NOT yet part of any journal row. */
export type LocalMediaDraft = {
  /** `local-media-<uuid>` (collision-checked by the id factory). */
  id: string;
  kind: MediaKind;
  owner: MediaOwner;
  /** Owned staging path while the take is uncommitted. */
  stagingPath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  width?: number;
  height?: number;
  originalFilename?: string;
  createdAt: string;
};

/** Metadata-only DTO handed to the journal store (no parent id, no URI). */
export type JournalMediaInput = {
  id: string;
  type: MediaKind;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  width?: number;
  height?: number;
  originalFilename?: string;
};

/** A verified durable file plus the metadata that may reference it. */
export type PreparedLocalMedia = {
  metadata: JournalMediaInput;
  /** Ownership manifest timestamp (canonical UTC). */
  createdAt: string;
};

/** Ephemeral runtime playback locator; never persisted. */
export type LocalPlaybackSource = {
  uri: string;
  mimeType: string;
  kind: MediaKind;
};

export type LocalMediaUnavailable = {
  unavailable: true;
  reason: 'missing-file' | 'invalid-manifest' | 'unreadable';
  message: string;
};

export type MediaResolution = LocalPlaybackSource | LocalMediaUnavailable;

export type CleanupResult = {
  removed: string[];
  failed: { path: string; message: string }[];
};

export type MediaFailureCode =
  | 'permission-denied'
  | 'permission-restricted'
  | 'permission-unavailable'
  | 'permission-error'
  | 'prepare-failed'
  | 'start-failed'
  | 'stop-failed'
  | 'capture-failed'
  | 'capture-empty'
  | 'stat-failed'
  | 'adopt-failed'
  | 'file-missing'
  | 'file-too-large'
  | 'duration-too-long'
  | 'duration-unknown'
  | 'mime-unsupported'
  | 'manifest-invalid'
  | 'cleanup-failed'
  | 'cancelled'
  | 'not-ready'
  | 'busy'
  | 'save-failed'
  | 'hardware-busy'
  | 'entry-missing'
  | 'validation-failed';

export type MediaFailure = {
  code: MediaFailureCode;
  /** Russian, user-visible; never includes a raw URI or secret. */
  message: string;
};

/** Limits/identity reasons that map onto user-facing Russian text. */
export function failureMessage(code: MediaFailureCode): string {
  switch (code) {
    case 'permission-denied':
      return 'Нет доступа. Разрешите его в настройках и повторите.';
    case 'permission-restricted':
      return 'Доступ ограничен системой. Проверьте настройки устройства.';
    case 'permission-unavailable':
      return 'Камера или микрофон недоступны на этом устройстве.';
    case 'permission-error':
      return 'Не удалось проверить разрешение. Повторите попытку.';
    case 'prepare-failed':
      return 'Не удалось подготовить запись. Повторите попытку.';
    case 'start-failed':
      return 'Не удалось начать запись. Повторите попытку.';
    case 'stop-failed':
      return 'Не удалось остановить запись. Повторите попытку.';
    case 'capture-failed':
      return 'Запись прервалась. Попробуйте ещё раз.';
    case 'capture-empty':
      return 'Запись получилась пустой. Попробуйте ещё раз.';
    case 'stat-failed':
      return 'Не удалось проверить файл записи. Повторите попытку.';
    case 'adopt-failed':
      return 'Не удалось сохранить файл записи на устройстве. Повторите попытку.';
    case 'file-missing':
      return 'Файл недоступен на этом устройстве.';
    case 'file-too-large':
      return 'Файл больше допустимого размера. Запишите короче.';
    case 'duration-too-long':
      return 'Запись длиннее допустимой. Запишите короче.';
    case 'duration-unknown':
      return 'Не удалось определить длительность записи. Попробуйте ещё раз.';
    case 'mime-unsupported':
      return 'Формат записи не поддерживается. Запишите заново.';
    case 'manifest-invalid':
      return 'Файл записи повреждён или не принадлежит приложению.';
    case 'cleanup-failed':
      return 'Не удалось удалить файл записи. Повторите попытку.';
    case 'cancelled':
      return 'Запись отменена.';
    case 'not-ready':
      return 'Запись ещё не готова. Повторите попытку.';
    case 'busy':
      return 'Дождитесь завершения предыдущего действия.';
    case 'save-failed':
      return 'Не удалось сохранить запись. Проверьте память устройства и повторите.';
    case 'hardware-busy':
      return 'Предыдущая запись ещё завершается. Повторите через пару секунд.';
    case 'entry-missing':
      return 'Запись больше не существует. Обновите экран.';
    case 'validation-failed':
      return 'Проверьте текст записи: изменения не сохранены.';
  }
}

export function mediaFailure(code: MediaFailureCode): MediaFailure {
  return { code, message: failureMessage(code) };
}
