import type { Assignment, CalendarEvent, FinanceState, Goal, Idea, JournalEntry, JournalMedia, PlanTask } from "./types";
import { normalizeFinanceState } from "./finance";
import { loadPlannerState, savePlannerState } from "./planner-storage";
import { MAX_AUDIO_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES } from "./media-limits";
import { mediaChunkBounds, retryMediaOperation } from "./media-upload";

export type PlannerApiConfig = { baseUrl: string; token: string; enabled: boolean };

export type PlannerSyncState = {
  tasks: PlanTask[];
  assignments: Assignment[];
  goals: Goal[];
  entries: JournalEntry[];
  events: CalendarEvent[];
  ideas: Idea[];
  finances: FinanceState;
  syncUpdatedAt?: string;
};

const API_CONFIG_KEY = "workazy-api-config";

// На опубликованном сайте синхронизация работает через подтверждённого
// пользователя Sites. URL и секрет больше не должны жить в localStorage.
export const defaultApiConfig: PlannerApiConfig = { baseUrl: "", token: "", enabled: true };

export function loadApiConfig(): PlannerApiConfig {
  if (typeof window === "undefined") return defaultApiConfig;
  try {
    const saved = window.localStorage.getItem(API_CONFIG_KEY);
    if (!saved) return defaultApiConfig;
    const parsed = JSON.parse(saved) as Partial<PlannerApiConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "",
      token: typeof parsed.token === "string" ? parsed.token.trim() : "",
      enabled: true,
    };
  } catch {
    return defaultApiConfig;
  }
}

export function saveApiConfig(config: PlannerApiConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(API_CONFIG_KEY, JSON.stringify(config));
}

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: string };

function apiUrl(config: PlannerApiConfig, path: string): string {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) return path;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Укажите корректный адрес сервера");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Адрес сервера должен начинаться с http:// или https://");
  }
  return `${baseUrl}${path}`;
}

function apiHeaders(config: PlannerApiConfig, headers: Record<string, string> = {}): Record<string, string> {
  return config.token
    ? { ...headers, Authorization: `Bearer ${config.token}` }
    : headers;
}

async function fetchSyncWithRetry(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.status < 500 || attempt === 2) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Синхронизация прервана");
}

async function readApiEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    if (response.status === 413) {
      throw new Error("Хостинг отклонил слишком большой запрос (413)");
    }
    throw new Error(`Сервер вернул некорректный ответ (${response.status})`);
  }
}

async function apiGet<T>(config: PlannerApiConfig, path: string): Promise<T> {
  const response = await fetch(apiUrl(config, path), {
    headers: apiHeaders(config),
  });
  const body = await readApiEnvelope<T>(response);
  if (!response.ok || !body.ok || body.data === undefined) {
    throw new Error(body.error || `API запрос завершился ошибкой (${response.status})`);
  }
  return body.data;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function fetchServerState(config: PlannerApiConfig): Promise<PlannerSyncState> {
  const state = await apiGet<Record<string, unknown>>(config, "/api/v1/state");
  return {
    tasks: asArray<PlanTask>(state.tasks),
    assignments: asArray<Assignment>(state.assignments),
    goals: asArray<Goal>(state.goals),
    entries: asArray<JournalEntry>(state.entries),
    events: asArray<CalendarEvent>(state.events),
    ideas: asArray<Idea>(state.ideas),
    finances: normalizeFinanceState(state.finances),
    syncUpdatedAt: typeof state.syncUpdatedAt === "string" ? state.syncUpdatedAt : undefined,
  };
}

export function countPlannerItems(state: PlannerSyncState) {
  const financeItems = state.finances.salarySchedules.length
    + state.finances.expenses.length
    + state.finances.obligations.length
    + (state.finances.balance > 0 ? 1 : 0);
  return state.tasks.length + state.assignments.length + state.goals.length + state.entries.length + state.events.length + state.ideas.length + financeItems;
}

export async function pushServerState(
  config: PlannerApiConfig,
  state: PlannerSyncState,
  { includeAssignments = false, clientUpdatedAt = new Date().toISOString() }: { includeAssignments?: boolean; clientUpdatedAt?: string } = {},
) {
  // Задания меняются через отдельные endpoints, чтобы обычное сохранение
  // плана не затёрло задание, которое параллельно добавил Workazy GPT.
  const payload = includeAssignments ? { ...state, syncUpdatedAt: clientUpdatedAt } : {
    tasks: state.tasks,
    goals: state.goals,
    entries: state.entries,
    events: state.events,
    ideas: state.ideas,
    finances: state.finances,
    syncUpdatedAt: clientUpdatedAt,
  };
  const response = await fetchSyncWithRetry(apiUrl(config, "/api/v1/state"), {
    method: "PUT",
    headers: apiHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
    keepalive: true,
  });
  const body = await readApiEnvelope<unknown>(response);
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `API запрос завершился ошибкой (${response.status})`);
  }
}

function mergeById<T extends { id: string }>(server: T[], local: T[], combine?: (serverItem: T, localItem: T) => T): T[] {
  const merged = new Map(server.map((item) => [item.id, item]));
  for (const item of local) {
    const serverItem = merged.get(item.id);
    merged.set(item.id, serverItem && combine ? combine(serverItem, item) : item);
  }
  return [...merged.values()];
}

function financeHasData(finances: FinanceState) {
  return finances.balance > 0 || finances.salarySchedules.length > 0 || finances.expenses.length > 0 || finances.obligations.length > 0;
}

function preferredFinanceState(server: FinanceState, local: FinanceState): FinanceState {
  if (!financeHasData(local)) return server;
  if (!financeHasData(server)) return local;
  if (local.updatedAt && server.updatedAt) return local.updatedAt > server.updatedAt ? local : server;
  return local.updatedAt ? local : server;
}

/** Миграция старого localStorage: ничего не удаляем, локальная правка выигрывает. */
export function mergePlannerStates(server: PlannerSyncState, local: PlannerSyncState): PlannerSyncState {
  return {
    tasks: mergeById(server.tasks, local.tasks),
    assignments: server.assignments,
    goals: mergeById(server.goals, local.goals),
    entries: mergeById(server.entries, local.entries, (serverEntry, localEntry) => ({
      ...serverEntry,
      ...localEntry,
      media: serverEntry.media ?? localEntry.media,
    })),
    events: mergeById(server.events, local.events),
    ideas: mergeById(server.ideas, local.ideas),
    finances: preferredFinanceState(server.finances, local.finances),
    syncUpdatedAt: local.syncUpdatedAt,
  };
}

/** Загружает состояние сервера; если сервер пуст — отправляет туда локальные данные. */
export async function adoptServerState(config: PlannerApiConfig): Promise<PlannerSyncState | null> {
  const server = await fetchServerState(config);
  const local = loadPlannerState();
  const localState: PlannerSyncState = {
    tasks: asArray<PlanTask>(local?.tasks),
    assignments: asArray<Assignment>(local?.assignments),
    goals: asArray<Goal>(local?.goals),
    entries: asArray<JournalEntry>(local?.entries),
    events: asArray<CalendarEvent>(local?.events),
    ideas: asArray<Idea>(local?.ideas),
    finances: normalizeFinanceState(local?.finances),
    syncUpdatedAt: local?.savedAt,
  };

  if (countPlannerItems(server) === 0) {
    await pushServerState(config, localState, { includeAssignments: true, clientUpdatedAt: local?.savedAt });
    return null;
  }
  if (countPlannerItems(localState) === 0) return server;

  // До этой версии время локального сохранения не записывалось. Один раз
  // объединяем обе копии, чтобы свежий пункт с телефона не мог исчезнуть.
  if (!local?.savedAt) {
    const merged = mergePlannerStates(server, localState);
    const mergedAt = new Date().toISOString();
    await pushServerState(config, merged, { clientUpdatedAt: mergedAt });
    return { ...merged, syncUpdatedAt: mergedAt };
  }

  if (server.syncUpdatedAt && local.savedAt > server.syncUpdatedAt) {
    const localPreferred = { ...localState, assignments: server.assignments };
    await pushServerState(config, localPreferred, { clientUpdatedAt: local.savedAt });
    return localPreferred;
  }
  return server;
}

/** Сохраняет состояние и локально, и на сервере (если синхронизация включена). */
export async function persistPlannerState(state: PlannerSyncState, config: PlannerApiConfig) {
  const savedAt = savePlannerState(state);
  if (config.enabled) {
    await pushServerState(config, state, { clientUpdatedAt: savedAt });
  }
}

// ---------- Медиа дневника ----------
// Бинарные файлы живут только на сервере (R2); клиент оперирует
// метаданными и короткоживущими подписанными ссылками на байты.

async function apiSend<T>(config: PlannerApiConfig, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(config, path), {
    ...init,
    headers: apiHeaders(config, init.headers as Record<string, string> | undefined),
  });
  const body = await readApiEnvelope<T>(response);
  if (!response.ok || !body.ok || body.data === undefined) {
    throw new Error(body.error || `API запрос завершился ошибкой (${response.status})`);
  }
  return body.data;
}

export async function createAssignmentRemote(config: PlannerApiConfig, input: { title: string; description?: string; dueDate?: string; completed?: boolean }): Promise<Assignment> {
  return apiSend<Assignment>(config, "/api/v1/assignments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateAssignmentRemote(config: PlannerApiConfig, id: string, changes: Partial<Pick<Assignment, "title" | "description" | "dueDate" | "completed">>): Promise<Assignment> {
  return apiSend<Assignment>(config, `/api/v1/assignments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
}

export async function deleteAssignmentRemote(config: PlannerApiConfig, id: string): Promise<void> {
  await apiSend<{ deleted: boolean }>(config, `/api/v1/assignments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function createJournalEntryRemote(config: PlannerApiConfig, entry: { id: string; date: string; title?: string; body?: string; mood?: string; tags?: string[] }): Promise<JournalEntry> {
  return apiSend<JournalEntry>(config, "/api/v1/journal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
}

export async function updateJournalEntryRemote(config: PlannerApiConfig, id: string, changes: Record<string, unknown>): Promise<JournalEntry & { media?: JournalMedia[] }> {
  return apiSend<JournalEntry & { media?: JournalMedia[] }>(config, `/api/v1/journal/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
}

export async function deleteJournalEntryRemote(config: PlannerApiConfig, id: string): Promise<void> {
  await apiSend<{ deleted: boolean }>(config, `/api/v1/journal/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchEntryMedia(config: PlannerApiConfig, entryId: string): Promise<JournalMedia[]> {
  return apiGet<JournalMedia[]>(config, `/api/v1/journal/${encodeURIComponent(entryId)}/media`);
}

export async function fetchMediaMetadata(config: PlannerApiConfig, mediaId: string): Promise<JournalMedia> {
  return apiGet<JournalMedia>(config, `/api/v1/journal/media/${encodeURIComponent(mediaId)}`);
}

export async function updateMediaTranscriptRemote(config: PlannerApiConfig, mediaId: string, transcript: string): Promise<JournalMedia> {
  return apiSend<JournalMedia>(config, `/api/v1/journal/media/${encodeURIComponent(mediaId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript }),
  });
}

export async function deleteMediaRemote(config: PlannerApiConfig, mediaId: string): Promise<void> {
  await apiSend<{ deleted: boolean }>(config, `/api/v1/journal/media/${encodeURIComponent(mediaId)}`, { method: "DELETE" });
}

export async function requestTranscription(config: PlannerApiConfig, mediaId: string): Promise<JournalMedia> {
  return apiSend<JournalMedia>(config, `/api/v1/journal/media/${encodeURIComponent(mediaId)}/transcribe`, { method: "POST" });
}

// Короткоживущая ссылка на байты — для <audio>/<video>, скачивания и бэкапа.
export async function fetchMediaPlaybackUrl(config: PlannerApiConfig, mediaId: string): Promise<string> {
  const data = await apiGet<{ url: string }>(config, `/api/v1/journal/media/${encodeURIComponent(mediaId)}/file-url`);
  return data.url.startsWith("http") ? data.url : apiUrl(config, data.url);
}

// Скачивание байтов по подписанной ссылке (подпись уже внутри).
export async function fetchMediaBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать файл (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export type MediaUploadInput = {
  journalEntryId: string;
  type: "audio" | "video";
  file: Blob;
  fileName: string;
  audioTrack?: Blob | null;
  audioTrackFileName?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
};

type MediaUploadSession = {
  id: string;
  chunkSizeBytes: number;
  main: { partCount: number; sizeBytes: number };
  track: { partCount: number; sizeBytes: number } | null;
};

class MediaChunkHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function validateMediaUploadSizes(input: MediaUploadInput): void {
  const mainLimit = input.type === "audio" ? MAX_AUDIO_SIZE_BYTES : MAX_VIDEO_SIZE_BYTES;
  if (input.file.size === 0) throw new Error("Файл записи пустой");
  if (input.file.size > mainLimit) {
    throw new Error(`${input.type === "audio" ? "Аудио" : "Видео"} превышает допустимый размер`);
  }
  if (input.audioTrack && input.audioTrack.size > MAX_AUDIO_SIZE_BYTES) {
    throw new Error("Аудиодорожка видео превышает допустимый размер");
  }
}

async function sendMediaChunk(
  config: PlannerApiConfig,
  sessionId: string,
  kind: "main" | "track",
  part: number,
  bytes: Blob,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(apiUrl(
    config,
    `/api/v1/journal/media/uploads/${encodeURIComponent(sessionId)}/parts/${kind}/${part}`,
  ), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
    signal,
  });
  let body: ApiEnvelope<unknown>;
  try {
    body = await response.json() as ApiEnvelope<unknown>;
  } catch {
    throw new MediaChunkHttpError(
      response.status,
      response.status === 413
        ? "Хостинг отклонил даже небольшой чанк (413)"
        : `Сервер вернул некорректный ответ (${response.status})`,
    );
  }
  if (!response.ok || !body.ok) {
    throw new MediaChunkHttpError(response.status, body.error || `Не удалось загрузить чанк (${response.status})`);
  }
}

async function uploadBlobParts(
  config: PlannerApiConfig,
  session: MediaUploadSession,
  kind: "main" | "track",
  blob: Blob,
  onLoaded: (loadedBytes: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const descriptor = kind === "main" ? session.main : session.track;
  if (!descriptor) return;
  for (let part = 0; part < descriptor.partCount; part += 1) {
    const bounds = mediaChunkBounds(blob.size, part, session.chunkSizeBytes);
    const chunk = blob.slice(bounds.start, bounds.end);
    await retryMediaOperation(
      () => sendMediaChunk(config, session.id, kind, part, chunk, signal),
      {
        signal,
        shouldRetry: (error) => !(error instanceof MediaChunkHttpError)
          || error.status === 408
          || error.status === 429
          || error.status >= 500,
      },
    );
    onLoaded(bounds.size);
  }
}

async function abortMediaUpload(config: PlannerApiConfig, sessionId: string): Promise<void> {
  await retryMediaOperation(async () => {
    const response = await fetch(apiUrl(config, `/api/v1/journal/media/uploads/${encodeURIComponent(sessionId)}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!response.ok) throw new MediaChunkHttpError(response.status, `Не удалось очистить загрузку (${response.status})`);
  }, {
    shouldRetry: (error) => !(error instanceof MediaChunkHttpError) || error.status >= 500,
  });
}

export async function uploadJournalMediaFile(config: PlannerApiConfig, input: MediaUploadInput): Promise<JournalMedia> {
  validateMediaUploadSizes(input);
  console.info("Workazy media upload sizes", {
    type: input.type,
    videoBytes: input.type === "video" ? input.file.size : 0,
    audioBytes: input.type === "audio" ? input.file.size : 0,
    audioTrackBytes: input.audioTrack?.size ?? 0,
  });

  const session = await apiSend<MediaUploadSession>(config, "/api/v1/journal/media/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      journalEntryId: input.journalEntryId,
      type: input.type,
      file: { sizeBytes: input.file.size, mimeType: input.file.type, fileName: input.fileName },
      audioTrack: input.audioTrack ? {
        sizeBytes: input.audioTrack.size,
        mimeType: input.audioTrack.type,
        fileName: input.audioTrackFileName,
      } : undefined,
      durationMs: input.durationMs,
      width: input.width,
      height: input.height,
    }),
    signal: input.signal,
  });

  const totalBytes = input.file.size + (input.audioTrack?.size ?? 0);
  let loadedBytes = 0;
  const report = (size: number) => {
    loadedBytes += size;
    input.onProgress?.(Math.min(99, Math.round((loadedBytes / totalBytes) * 100)));
  };

  try {
    await uploadBlobParts(config, session, "main", input.file, report, input.signal);
    if (input.audioTrack) {
      await uploadBlobParts(config, session, "track", input.audioTrack, report, input.signal);
    }
    const media = await apiSend<JournalMedia>(
      config,
      `/api/v1/journal/media/uploads/${encodeURIComponent(session.id)}/complete`,
      { method: "POST", signal: input.signal },
    );
    input.onProgress?.(100);
    return media;
  } catch (error) {
    await abortMediaUpload(config, session.id).catch((cleanupError) => {
      console.error("Workazy media upload abort cleanup failed", {
        uploadId: session.id,
        cause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });
    if (input.signal?.aborted) throw new Error("Загрузка отменена");
    throw error;
  }
}
