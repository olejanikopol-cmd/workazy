export const dynamic = "force-dynamic";

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { jsonError, jsonOk, requireApiToken } from "@/lib/api";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireApiToken(request);
  if (denied) return denied;

  try {
    const db = await getDb();
    await db.run(sql`select 1`);
    return jsonOk({ status: "ok", database: "connected" });
  } catch (error) {
    console.error(error);
    return jsonError(503, "База данных недоступна");
  }
}
