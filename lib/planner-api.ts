import type { CalendarEvent, Goal, Idea, JournalEntry, JournalMedia, PlanTask } from "./types";
import { loadPlannerState, savePlannerState } from "./planner-storage";

export type PlannerApiConfig = { baseUrl: string; token: string; enabled: boolean };

export type PlannerSyncState = {
  tasks: PlanTask[];
  goals: Goal[];
  entries: JournalEntry[];
  events: CalendarEvent[];
  ideas: Idea[];
};

const API_CONFIG_KEY = "workazy-api-config";

export const defaultApiConfig: PlannerApiConfig = { baseUrl: "", token: "", enabled: false };

export function loadApiConfig(): PlannerApiConfig {
  if (typeof window === "undefined") return defaultApiConfig;
  try {
    const saved = window.localStorage.getItem(API_CONFIG_KEY);
    if (!saved) return defaultApiConfig;
    const parsed = JSON.parse(saved) as Partial<PlannerApiConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "",
      token: typeof parsed.token === "string" ? parsed.token.trim() : "",
      enabled: parsed.enabled === true,
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

async function readApiEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`Сервер вернул некорректный ответ (${response.status})`);
  }
}

async function apiGet<T>(config: PlannerApiConfig, path: string): Promise<T> {
  const response = await fetch(apiUrl(config, path), {
    headers: { Authorization: `Bearer ${config.token}` },
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
    goals: asArray<Goal>(state.goals),
    entries: asArray<JournalEntry>(state.entries),
    events: asArray<CalendarEvent>(state.events),
    ideas: asArray<Idea>(state.ideas),
  };
}

export function countPlannerItems(state: PlannerSyncState) {
  return state.tasks.length + state.goals.length + state.entries.length + state.events.length + state.ideas.length;
}

export async function pushServerState(config: PlannerApiConfig, state: PlannerSyncState) {
  const response = await fetch(apiUrl(config, "/api/v1/state"), {
    method: "PUT",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  const body = await readApiEnvelope<unknown>(response);
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `API запрос завершился ошибкой (${response.status})`);
  }
}

/** Загружает состояние сервера; если сервер пуст — отправляет туда локальные данные. */
export async function adoptServerState(config: PlannerApiConfig): Promise<PlannerSyncState | null> {
  const server = await fetchServerState(config);
  if (countPlannerItems(server) > 0) return server;
  const local = loadPlannerState();
  await pushServerState(config, {
    tasks: asArray<PlanTask>(local?.tasks),
    goals: asArray<Goal>(local?.goals),
    entries: asArray<JournalEntry>(local?.entries),
    events: asArray<CalendarEvent>(local?.events),
    ideas: asArray<Idea>(local?.ideas),
  });
  return null;
}

/** Сохраняет состояние и локально, и на сервере (если синхронизация включена). */
export async function persistPlannerState(state: PlannerSyncState, config: PlannerApiConfig) {
  savePlannerState(state);
  if (config.enabled && config.token && config.baseUrl) {
    await pushServerState(config, state);
  }
}

// ---------- Медиа дневника ----------
// Бинарные файлы живут только на сервере (R2); клиент оперирует
// метаданными и короткоживущими подписанными ссылками на байты.

async function apiSend<T>(config: PlannerApiConfig, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(config, path), {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${config.token}` },
  });
  const body = await readApiEnvelope<T>(response);
  if (!response.ok || !body.ok || body.data === undefined) {
    throw new Error(body.error || `API запрос завершился ошибкой (${response.status})`);
  }
  return body.data;
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

// Загрузка через XMLHttpRequest — только так виден прогресс отправки.
export function uploadJournalMediaFile(config: PlannerApiConfig, input: MediaUploadInput): Promise<JournalMedia> {
  return new Promise((resolve, reject) => {
    let url: string;
    try {
      url = apiUrl(config, "/api/v1/journal/media");
    } catch (error) {
      reject(error as Error);
      return;
    }
    const form = new FormData();
    form.append("journalEntryId", input.journalEntryId);
    form.append("type", input.type);
    if (input.durationMs) form.append("durationMs", String(input.durationMs));
    if (input.width) form.append("width", String(input.width));
    if (input.height) form.append("height", String(input.height));
    form.append("file", input.file, input.fileName);
    if (input.audioTrack) form.append("audioTrack", input.audioTrack, input.audioTrackFileName ?? "audio-track");

    const xhr = new XMLHttpRequest();
    const abortUpload = () => xhr.abort();
    const cleanup = () => input.signal?.removeEventListener("abort", abortUpload);
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${config.token}`);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && input.onProgress) {
        input.onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    });
    xhr.addEventListener("load", () => {
      cleanup();
      try {
        const body = JSON.parse(xhr.responseText) as ApiEnvelope<JournalMedia>;
        if (xhr.status >= 200 && xhr.status < 300 && body.ok && body.data) {
          input.onProgress?.(100);
          resolve(body.data);
          return;
        }
        reject(new Error(body.error || `Загрузка завершилась ошибкой (${xhr.status})`));
      } catch {
        reject(new Error(`Сервер вернул некорректный ответ (${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => { cleanup(); reject(new Error("Не удалось загрузить файл: ошибка сети")); });
    xhr.addEventListener("abort", () => { cleanup(); reject(new Error("Загрузка отменена")); });
    if (input.signal?.aborted) {
      reject(new Error("Загрузка отменена"));
      return;
    }
    input.signal?.addEventListener("abort", abortUpload, { once: true });
    xhr.send(form);
  });
}
