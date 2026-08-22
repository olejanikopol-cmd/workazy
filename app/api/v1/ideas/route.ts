export const dynamic = "force-dynamic";

import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ideas } from "@/db/schema";
import { ideaToJson, jsonOk, newId, nowIso, readJsonBody, readOneOf, readOptionalText, requireOneOf, requireText, withApi } from "@/lib/api";

const CATEGORIES = ["thought", "want", "project", "purchase", "someday"] as const;
const STATUSES = ["new", "thinking", "plan", "done", "archive"] as const;

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const category = readOneOf(url.searchParams.get("category"), "category", CATEGORIES, { required: false });
  const status = readOneOf(url.searchParams.get("status"), "status", STATUSES, { required: false });
  const conditions = [category ? eq(ideas.category, category) : undefined, status ? eq(ideas.status, status) : undefined].filter(Boolean);
  const db = await getDb();
  const rows = conditions.length
    ? await db.select().from(ideas).where(and(...conditions)).orderBy(desc(ideas.createdAt))
    : await db.select().from(ideas).orderBy(asc(ideas.createdAt));
  return jsonOk(rows.map(ideaToJson));
});

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  const title = requireText(body.title, "title", { maxLength: 300 });
  const description = readOptionalText(body.description, "description", { maxLength: 2000 }) ?? null;
  const category = requireOneOf(body.category, "category", CATEGORIES);
  const status = readOneOf(body.status, "status", STATUSES, { required: false }) ?? "new";
  const now = nowIso();
  const row = { id: newId("idea"), title, description, category, status, createdAt: now, updatedAt: now };
  const db = await getDb();
  await db.insert(ideas).values(row);
  return jsonOk(ideaToJson(row), 201);
});