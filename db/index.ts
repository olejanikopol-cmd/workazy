// Runtime helper for Cloudflare Workers/vinext hosting.
// Use this only in server code that should run on Cloudflare.
//
// Модуль `cloudflare:workers` импортируется лениво: статический импорт
// выполнялся бы при сборке/проверке страниц в Node и ломал бы сборку.
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let cachedDb: Db | null = null;
let cachedBinding: D1Database | null = null;

export async function getD1Binding(): Promise<D1Database> {
  if (cachedBinding) return cachedBinding;
  const { env } = await import("cloudflare:workers");
  const binding = env.DB;
  if (!binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB`.",
    );
  }
  cachedBinding = binding;
  return binding;
}

export async function getDb(): Promise<Db> {
  if (cachedDb) return cachedDb;
  const binding = await getD1Binding();
  cachedDb = drizzle(binding, { schema });
  return cachedDb;
}
