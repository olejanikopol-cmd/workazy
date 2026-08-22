export const dynamic = "force-dynamic";

import { and, asc, eq, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { reminderLogs } from "@/db/schema";
import { jsonOk, nowIso, readIsoDateTime, reminderToJson, withApi } from "@/lib/api";

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const now = readIsoDateTime(url.searchParams.get("now"), "now", { required: false }) ?? nowIso();
  const db = await getDb();
  const rows = await db
    .select()
    .from(reminderLogs)
    .where(and(eq(reminderLogs.status, "pending"), lte(reminderLogs.dueAt, now)))
    .orderBy(asc(reminderLogs.dueAt))
    .limit(50);
  return jsonOk(rows.map(reminderToJson));
});
