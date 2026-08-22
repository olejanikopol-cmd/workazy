export const dynamic = "force-dynamic";

import { and, asc, desc, gte, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, journalEntries, tasks } from "@/db/schema";
import { entryToJson, eventToJson, jsonOk, readIsoDate, taskToJson, todayDate, withApi } from "@/lib/api";

function formatIso(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function shiftDays(iso: string, days: number): string {
  const day = new Date(`${iso}T12:00:00`);
  day.setDate(day.getDate() + days);
  return formatIso(day);
}

/** Понедельник недели, в которую входит дата. */
function mondayOf(iso: string): string {
  const day = new Date(`${iso}T12:00:00`);
  const weekday = (day.getDay() + 6) % 7;
  return shiftDays(iso, -weekday);
}

export const GET = withApi(async (request) => {
  const url = new URL(request.url);
  const anchor = readIsoDate(url.searchParams.get("date"), "date", { required: false }) ?? todayDate();
  const start = mondayOf(anchor);
  const end = shiftDays(start, 6);
  const db = await getDb();

  const [weekTasks, weekEvents, weekEntries] = await Promise.all([
    db.select().from(tasks).where(and(gte(tasks.date, start), lte(tasks.date, end))).orderBy(asc(tasks.date), asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(and(gte(calendarEvents.date, start), lte(calendarEvents.date, end))).orderBy(asc(calendarEvents.date), asc(calendarEvents.time)),
    db.select().from(journalEntries).where(and(gte(journalEntries.date, start), lte(journalEntries.date, end))).orderBy(desc(journalEntries.date), desc(journalEntries.createdAt)),
  ]);

  const byDay: Record<string, { tasks: number; completed: number; events: number; entries: number }> = {};
  for (let offset = 0; offset < 7; offset += 1) {
    byDay[shiftDays(start, offset)] = { tasks: 0, completed: 0, events: 0, entries: 0 };
  }
  for (const row of weekTasks) {
    byDay[row.date].tasks += 1;
    if (row.completed) byDay[row.date].completed += 1;
  }
  for (const row of weekEvents) byDay[row.date].events += 1;
  for (const row of weekEntries) byDay[row.date].entries += 1;

  const totalTasks = weekTasks.length;
  const completedTasks = weekTasks.filter((task) => task.completed).length;
  return jsonOk({
    start,
    end,
    tasks: weekTasks.map(taskToJson),
    events: weekEvents.map(eventToJson),
    journal: weekEntries.map(entryToJson),
    byDay,
    stats: { totalTasks, completedTasks, totalEvents: weekEvents.length, totalEntries: weekEntries.length },
    summaryText: `Неделя ${start}…${end}: задач ${completedTasks} из ${totalTasks} выполнено, событий ${weekEvents.length}, записей дневника ${weekEntries.length}.`,
  });
});
