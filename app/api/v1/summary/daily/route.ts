export const dynamic = "force-dynamic";

import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, ideas, journalEntries, tasks } from "@/db/schema";
import { entryToJson, eventToJson, ideaToJson, jsonOk, readIsoDate, taskToJson, todayDate, withApi } from "@/lib/api";

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const date = readIsoDate(url.searchParams.get("date"), "date", { required: false }) ?? todayDate();
  const db = await getDb();

  const [dayTasks, dayEvents, dayEntries, activeIdeas] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.date, date)).orderBy(asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(eq(calendarEvents.date, date)).orderBy(asc(calendarEvents.time)),
    db.select().from(journalEntries).where(eq(journalEntries.date, date)).orderBy(desc(journalEntries.createdAt)),
    db.select().from(ideas).where(inArray(ideas.status, ["new", "thinking", "plan"])).orderBy(desc(ideas.updatedAt)).limit(5),
  ]);

  const completedCount = dayTasks.filter((task) => task.completed).length;
  return jsonOk({
    date,
    tasks: dayTasks.map(taskToJson),
    events: dayEvents.map(eventToJson),
    journal: dayEntries.map(entryToJson),
    ideas: activeIdeas.map(ideaToJson),
    summaryText: `На ${date}: выполнено задач ${completedCount} из ${dayTasks.length}, событий ${dayEvents.length}, записей дневника ${dayEntries.length}, активных идей ${activeIdeas.length}.`,
  });
});