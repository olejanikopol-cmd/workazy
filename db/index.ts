// Runtime helper for Cloudflare Workers/vinext hosting.
// Use this only in server code that should run on Cloudflare.
//
// Модуль `cloudflare:workers` импортируется лениво: статический импорт
// выполнялся бы при сборке/проверке страниц в Node и ломал бы сборку.
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let cachedDb: Db | null = null;

export async function getDb(): Promise<Db> {
  if (cachedDb) return cachedDb;
  const { env } = await import("cloudflare:workers");
  const binding = env.DB;
  if (!binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB`.",
    );
  }
  cachedDb = drizzle(binding, { schema });
  return cachedDb;
}
