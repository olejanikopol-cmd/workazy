export const dynamic = "force-dynamic";

import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { goals } from "@/db/schema";
import { goalToJson, jsonOk, newId, nowIso, readBool, readInt, readJsonBody, readOneOf, readOptionalText, requireIsoDate, requireOneOf, requireText, withApi } from "@/lib/api";

const PERIODS = ["week", "month", "year"] as const;

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const period = readOneOf(url.searchParams.get("period"), "period", PERIODS, { required: false });
  const db = await getDb();
  const rows = period
    ? await db.select().from(goals).where(eq(goals.period, period)).orderBy(asc(goals.createdAt))
    : await db.select().from(goals).orderBy(asc(goals.createdAt));
  return jsonOk(rows.map(goalToJson));
});

export const POST = withApi(async (request) => {
  const body = await readJsonBody(request);
  const title = requireText(body.title, "title", { maxLength: 300 });
  const description = readOptionalText(body.description, "description", { maxLength: 1000 }) ?? null;
  const period = requireOneOf(body.period, "period", PERIODS);
  const progress = readInt(body.progress, "progress", { min: 0, max: 100 }) ?? 0;
  const deadline = requireIsoDate(body.deadline, "deadline");
  const completed = readBool(body.completed, "completed") ?? false;
  const now = nowIso();
  const row = { id: newId("goal"), title, description, period, progress, deadline, completed, createdAt: now, updatedAt: now };
  const db = await getDb();
  await db.insert(goals).values(row);
  return jsonOk(goalToJson(row), 201);
});