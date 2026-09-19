export const dynamic = "force-dynamic";

import { asc, desc, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { assignments, calendarEvents, goals, journalEntries, journalMedia, settings, tasks } from "@/db/schema";
import { todayDate } from "@/lib/api";
import { FINANCE_STATE_KEY, normalizeFinanceState } from "@/lib/finance";
import { verifyGithubActionsRequest } from "@/lib/github-oidc";

function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  if (!(await verifyGithubActionsRequest(request))) {
    return Response.json({ ok: false, error: "Unauthorized" }, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }

  const end = todayDate();
  const start = shiftDate(end, -6);
  const db = await getDb();

  const [weekTasks, weekEvents, weekEntries, currentAssignments, allGoals, financeRows] = await Promise.all([
    db.select().from(tasks)
      .where(gte(tasks.date, start))
      .orderBy(asc(tasks.date), asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents)
      .where(gte(calendarEvents.date, start))
      .orderBy(asc(calendarEvents.date), asc(calendarEvents.time)),
    db.select().from(journalEntries)
      .where(gte(journalEntries.date, start))
      .orderBy(desc(journalEntries.date), desc(journalEntries.createdAt)),
    db.select().from(assignments)
      .orderBy(desc(assignments.updatedAt))
      .limit(100),
    db.select().from(goals)
      .orderBy(asc(goals.period), asc(goals.deadline), asc(goals.createdAt)),
    db.select({ value: settings.value }).from(settings)
      .where(inArray(settings.key, [FINANCE_STATE_KEY]))
      .limit(1),
  ]);

  const boundedTasks = weekTasks.filter((item) => item.date <= end);
  const boundedEvents = weekEvents.filter((item) => item.date <= end);
  const boundedEntries = weekEntries.filter((item) => item.date <= end);
  const entryIds = boundedEntries.map((entry) => entry.id);
  const mediaRows = entryIds.length
    ? await db.select({
      journalEntryId: journalMedia.journalEntryId,
      type: journalMedia.type,
      transcript: journalMedia.transcript,
      transcriptionStatus: journalMedia.transcriptionStatus,
      createdAt: journalMedia.createdAt,
    }).from(journalMedia)
      .where(inArray(journalMedia.journalEntryId, entryIds))
      .orderBy(asc(journalMedia.createdAt))
    : [];

  const transcriptsByEntry = new Map<string, Array<{
    type: string;
    transcript: string | null;
    transcriptionStatus: string;
  }>>();
  for (const media of mediaRows) {
    const list = transcriptsByEntry.get(media.journalEntryId) ?? [];
    list.push({
      type: media.type,
      transcript: media.transcript,
      transcriptionStatus: media.transcriptionStatus,
    });
    transcriptsByEntry.set(media.journalEntryId, list);
  }

  let finance = null;
  if (financeRows[0]?.value) {
    try {
      finance = normalizeFinanceState(JSON.parse(financeRows[0].value));
    } catch {
      finance = null;
    }
  }
  const weekFinance = finance ? {
    balance: finance.balance,
    salarySchedules: finance.salarySchedules,
    expenses: finance.expenses.filter((expense) => expense.date >= start && expense.date <= end),
    obligations: finance.obligations,
    updatedAt: finance.updatedAt,
  } : null;

  const payload = {
    generatedAt: new Date().toISOString(),
    period: { start, end, days: 7 },
    tasks: boundedTasks.map((task) => ({
      id: task.id,
      title: task.title,
      date: task.date,
      completed: task.completed,
      position: task.position,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
    events: boundedEvents.map((event) => ({
      id: event.id,
      title: event.title,
      date: event.date,
      time: event.time,
      note: event.note,
      reminder: event.reminder,
    })),
    journal: boundedEntries.map((entry) => ({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      body: entry.body ?? "",
      mood: entry.mood,
      tags: parseJsonArray(entry.tags),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      media: transcriptsByEntry.get(entry.id) ?? [],
    })),
    assignments: currentAssignments.map((assignment) => ({
      id: assignment.id,
      title: assignment.title,
      description: assignment.description,
      dueDate: assignment.dueDate,
      completed: assignment.completed,
      createdAt: assignment.createdAt,
      updatedAt: assignment.updatedAt,
    })),
    goals: allGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      period: goal.period,
      progress: goal.progress,
      deadline: goal.deadline,
      completed: goal.completed,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    })),
    finance: weekFinance,
    stats: {
      tasks: boundedTasks.length,
      events: boundedEvents.length,
      journalEntries: boundedEntries.length,
      assignments: currentAssignments.length,
      goals: allGoals.length,
      weeklyExpenses: weekFinance?.expenses.length ?? 0,
    },
  };

  return Response.json({ ok: true, data: payload }, {
    headers: {
      "cache-control": "no-store, private",
      "content-type": "application/json; charset=utf-8",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}
