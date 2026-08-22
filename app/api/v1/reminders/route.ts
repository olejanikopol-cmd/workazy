export const dynamic = "force-dynamic";

import { getDb } from "@/db";
import { reminderLogs } from "@/db/schema";
import { jsonOk, readJsonBody, readOptionalText, readText, reminderToJson, requireIsoDateTime, requireOneOf, requireText, withApi } from "@/lib/api";

// Из-за отсутствия планировщика напоминания создаются явно:
// бот/сайт/действия создают запись, затем бот забирает созревшие через /reminders/pending.

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  const entityType = requireOneOf(body.entityType, "entityType", ["task", "event"] as const);
  const entityId = requireText(body.entityId, "entityId", { maxLength: 80 });
  const dueAt = requireIsoDateTime(body.dueAt, "dueAt");
  const channel = readText(body.channel, "channel", { required: false, maxLength: 20 }) ?? "telegram";
  const payload = readOptionalText(body.payload, "payload", { maxLength: 2000 }) ?? null;

  const db = await getDb();
  const result = await db
    .insert(reminderLogs)
    .values({ entityType, entityId, dueAt, channel, status: "pending", payload })
    .returning();
  return jsonOk(reminderToJson(result[0]), 201);
});
