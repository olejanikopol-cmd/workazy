import type { CalendarEvent, Goal, Idea, JournalEntry, PlanTask } from "./types";
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
