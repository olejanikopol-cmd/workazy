export const dynamic = "force-dynamic";

import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { assignments } from "@/db/schema";
import { assignmentToJson, jsonOk, newId, nowIso, readBool, readIsoDate, readJsonBody, readOptionalText, readQueryBool, requireText, withApi } from "@/lib/api";

export const GET = withApi(async (request) => {
  const completed = readQueryBool(new URL(request.url).searchParams.get("completed"), "completed");
  const db = await getDb();
  const query = db.select().from(assignments);
  const rows = completed === undefined
    ? await query.orderBy(asc(assignments.completed), asc(assignments.dueDate), desc(assignments.createdAt))
    : await query.where(eq(assignments.completed, completed)).orderBy(asc(assignments.dueDate), desc(assignments.createdAt));
  return jsonOk(rows.map(assignmentToJson));
});

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  const now = nowIso();
  const row = {
    id: newId("assignment"),
    title: requireText(body.title, "title", { maxLength: 300 }),
    description: readOptionalText(body.description, "description", { maxLength: 2000 }) ?? null,
    dueDate: readIsoDate(body.dueDate, "dueDate", { required: false }) ?? null,
    completed: readBool(body.completed, "completed") ?? false,
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  await db.insert(assignments).values(row);
  return jsonOk(assignmentToJson(row), 201);
});
