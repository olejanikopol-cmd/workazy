export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { settings } from "@/db/schema";
import { ApiError, jsonOk, nowIso, readJsonBody, withApi } from "@/lib/api";

const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 2000;

function parseStoredValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export const GET = withApi(async () => {
  const db = await getDb();
  const rows = await db.select().from(settings);
  const data: Record<string, unknown> = {};
  for (const row of rows) data[row.key] = parseStoredValue(row.value);
  return jsonOk(data);
});

export const PATCH = withApi(async (request) => {
  const body = await readJsonBody(request);
  const keys = Object.keys(body);
  if (!keys.length) throw new ApiError(400, "Передайте хотя бы одну настройку");
  if (keys.length > MAX_KEYS) throw new ApiError(400, `Нельзя обновить больше ${MAX_KEYS} настроек за раз`);

  const now = nowIso();
  const db = await getDb();
  for (const key of keys) {
    if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(key) || key.length > MAX_KEY_LENGTH) {
      throw new ApiError(400, `Некорректный ключ настройки: ${key}`);
    }
    let value: string;
    try {
      value = typeof body[key] === "string" ? (body[key] as string) : JSON.stringify(body[key]);
    } catch {
      throw new ApiError(400, `Настройку «${key}» нельзя сериализовать`);
    }
    if (value.length > MAX_VALUE_LENGTH) throw new ApiError(400, `Значение настройки «${key}» слишком длинное`);

    const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (existing.length) {
      await db.update(settings).set({ value, updatedAt: now }).where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({ key, value, updatedAt: now });
    }
  }

  const rows = await db.select().from(settings);
  const data: Record<string, unknown> = {};
  for (const row of rows) data[row.key] = parseStoredValue(row.value);
  return jsonOk(data);
});