// Ядро API: авторизация, валидация, ответы, сериализация строк БД.
// Роуты оборачиваются в withApi(): проверка токена + единый формат ошибок.
import type { calendarEvents, goals, ideas, journalEntries, reminderLogs, tasks } from "@/db/schema";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- Ответы ----------

export function jsonOk(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

// ---------- Авторизация ----------
// Пока один статический токен (секрет WORKAZY_API_TOKEN).
// Когда появится настоящая авторизация, она подключится только здесь.

async function getExpectedApiToken(): Promise<string | undefined> {
  if (process.env.WORKAZY_API_TOKEN) return process.env.WORKAZY_API_TOKEN;
  try {
    const { env } = await import("cloudflare:workers");
    return typeof env.WORKAZY_API_TOKEN === "string" ? env.WORKAZY_API_TOKEN : undefined;
  } catch {
    return undefined;
  }
}

export async function requireApiToken(request: Request): Promise<Response | null> {
  const expected = await getExpectedApiToken();
  if (!expected) return jsonError(503, "API-токен не настроен на сервере");
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== expected) return jsonError(401, "Требуется авторизация");
  return null;
}

// ---------- Валидация ----------

type TextOptions = { required?: boolean; maxLength?: number };

export function readText(value: unknown, field: string, options?: TextOptions): string | undefined {
  if (value === undefined || value === null) {
    if (options?.required ?? true) throw new ApiError(400, `Поле «${field}» обязательно`);
    return undefined;
  }
  if (typeof value !== "string") throw new ApiError(400, `Поле «${field}» должно быть строкой`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (options?.required ?? true) throw new ApiError(400, `Поле «${field}» не может быть пустым`);
    return undefined;
  }
  const maxLength = options?.maxLength ?? 500;
  if (trimmed.length > maxLength) throw new ApiError(400, `Поле «${field}» длиннее ${maxLength} символов`);
  return trimmed;
}

// Обязательное текстовое поле: бросает 400 и гарантирует тип string.
export function requireText(value: unknown, field: string, options: { maxLength?: number } = {}): string {
  return readText(value, field, { ...options, required: true }) as string;
}

// undefined — поле отсутствует (не менять), null — очистить, строка — записать.
export function readOptionalText(value: unknown, field: string, { maxLength = 500 }: { maxLength?: number } = {}): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(400, `Поле «${field}» должно быть строкой или null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw new ApiError(400, `Поле «${field}» длиннее ${maxLength} символов`);
  return trimmed;
}

export function readBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  throw new ApiError(400, `Поле «${field}» должно быть булевым`);
}

export function readQueryBool(value: string | null, field: string): boolean | undefined {
  if (value === null || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiError(400, `Параметр «${field}» должен быть true или false`);
}

export function readInt(value: unknown, field: string, { min, max }: { min?: number; max?: number } = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ApiError(400, `Поле «${field}» должно быть целым числом`);
  if (min !== undefined && value < min) throw new ApiError(400, `Поле «${field}» меньше допустимого (${min})`);
  if (max !== undefined && value > max) throw new ApiError(400, `Поле «${field}» больше допустимого (${max})`);
  return value;
}

export function readOneOf<T extends string>(value: unknown, field: string, options: readonly T[], { required = true }: { required?: boolean } = {}): T | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ApiError(400, `Поле «${field}» обязательно`);
    return undefined;
  }
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    throw new ApiError(400, `Поле «${field}» должно быть одним из: ${options.join(", ")}`);
  }
  return value as T;
}

// Обязательный выбор из списка: бросает 400 и гарантирует тип.
export function requireOneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  return readOneOf(value, field, options) as T;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function readIsoDate(value: unknown, field: string, { required = true }: { required?: boolean } = {}): string | undefined {
  const text = readText(value, field, { required });
  if (text === undefined) return undefined;
  if (!isRealIsoDate(text)) throw new ApiError(400, `Поле «${field}» должно быть реальной датой в формате YYYY-MM-DD`);
  return text;
}

// Обязательная дата: бросает 400 и гарантирует тип string.
export function requireIsoDate(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!isRealIsoDate(text)) throw new ApiError(400, `Поле «${field}» должно быть реальной датой в формате YYYY-MM-DD`);
  return text;
}

export function readOptionalTime(value: unknown, field: string): string | null | undefined {
  const text = readOptionalText(value, field, { maxLength: 5 });
  if (text === null || text === undefined) return text;
  if (!ISO_TIME.test(text)) throw new ApiError(400, `Поле «${field}» должно быть временем в формате HH:MM`);
  return text;
}

export function readIsoDateTime(value: unknown, field: string, { required = true }: { required?: boolean } = {}): string | undefined {
  const text = readText(value, field, { required, maxLength: 40 });
  if (text === undefined) return undefined;
  if (!ISO_DATE_TIME.test(text)) {
    throw new ApiError(400, `Поле «${field}» должно быть ISO датой-временем с часовым поясом`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, `Поле «${field}» содержит некорректную дату-время`);
  return parsed.toISOString();
}

export function requireIsoDateTime(value: unknown, field: string): string {
  return readIsoDateTime(value, field) as string;
}

export function readTags(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiError(400, `Поле «${field}» должно быть массивом строк`);
  return value.slice(0, 20).map((item, index) => requireText(item, `${field}[${index}]`, { maxLength: 40 }));
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiError(400, "Тело запроса должно быть JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "Тело запроса должно быть объектом");
  return parsed as Record<string, unknown>;
}

// ---------- Вспомогательное ----------

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayDate(now = new Date(), timeZone = process.env.WORKAZY_TIME_ZONE ?? "Europe/Kyiv"): string {
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

type RouteParams = Record<string, string>;
type RouteContext<Params> = { params: Promise<Params> };

export async function readIdParam(context: { params: Promise<unknown> }): Promise<string> {
  const params = (await context.params) as Record<string, unknown>;
  return requireText(params.id, "id", { maxLength: 80 });
}

export function withApi<Params extends RouteParams = RouteParams>(
  handler: (request: Request, context: RouteContext<Params>) => Promise<Response> | Response,
) {
  return async (request: Request, context: RouteContext<Params>): Promise<Response> => {
    const denied = await requireApiToken(request);
    if (denied) return denied;
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ApiError) return jsonError(error.status, error.message);
      console.error(error);
      return jsonError(500, "Внутренняя ошибка сервера");
    }
  };
}

// ---------- Сериализация строк БД в JSON (camelCase, как типы фронтенда) ----------

export function taskToJson(row: typeof tasks.$inferSelect) {
  return { id: row.id, title: row.title, completed: row.completed, date: row.date, position: row.position, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function goalToJson(row: typeof goals.$inferSelect) {
  return { id: row.id, title: row.title, description: row.description ?? undefined, period: row.period, progress: row.progress, createdAt: row.createdAt, deadline: row.deadline, completed: row.completed, updatedAt: row.updatedAt };
}

export function entryToJson(row: typeof journalEntries.$inferSelect) {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    tags = [];
  }
  return { id: row.id, date: row.date, title: row.title ?? undefined, body: row.body, mood: row.mood ?? undefined, tags, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function eventToJson(row: typeof calendarEvents.$inferSelect) {
  return { id: row.id, title: row.title, date: row.date, time: row.time ?? undefined, note: row.note ?? undefined, reminder: row.reminder ?? undefined, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function ideaToJson(row: typeof ideas.$inferSelect) {
  return { id: row.id, title: row.title, description: row.description ?? undefined, category: row.category, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function reminderToJson(row: typeof reminderLogs.$inferSelect) {
  let payload: unknown;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as unknown;
    } catch {
      payload = row.payload;
    }
  }
  return { id: row.id, entityType: row.entityType, entityId: row.entityId, dueAt: row.dueAt, sentAt: row.sentAt, channel: row.channel, status: row.status, payload };
}
