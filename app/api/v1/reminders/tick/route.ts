export const dynamic = "force-dynamic";

// Почасовой дайджест для Telegram-бота:
// невыполненные задачи на сегодня + события на сегодня + прогресс дня.
// Анти-спам: сообщение отправляется только если картина дня изменилась
// с последней отправки (хэш состава хранится в reminder_logs, payload).
// Внешний планировщик вызывает раз в час: POST /api/v1/reminders/tick.
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, reminderLogs, tasks } from "@/db/schema";
import { ApiError, jsonOk, nowIso, readQueryBool, todayDate, withApi } from "@/lib/api";
import { sendTelegramMessage } from "@/lib/telegram";

const DIGEST_ENTITY = "digest";
const DIGEST_ID = "hourly";
const LIST_LIMIT = 15;

type DigestTask = { id: string; title: string; completed: boolean };
type DigestEvent = { id: string; title: string; time: string | null };

function digestHash(dayTasks: DigestTask[], events: DigestEvent[]): string {
  const input = JSON.stringify({
    tasks: dayTasks.map(({ id, title, completed }) => ({ id, title, completed })),
    events: events.map(({ id, title, time }) => ({ id, title, time })),
  });
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
}

function currentTime(): string {
  const timeZone = process.env.WORKAZY_TIME_ZONE ?? "Europe/Kyiv";
  try {
    return new Intl.DateTimeFormat("en", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  } catch {
    return new Date().toTimeString().slice(0, 5);
  }
}

function formatList(items: string[]): string[] {
  const lines = items.slice(0, LIST_LIMIT);
  if (items.length > LIST_LIMIT) lines.push(`…и ещё ${items.length - LIST_LIMIT}`);
  return lines;
}

function buildMessage(dayTasks: DigestTask[], dayEvents: DigestEvent[]): string {
  const completedCount = dayTasks.filter((task) => task.completed).length;
  const pendingTasks = dayTasks.filter((task) => !task.completed);
  const lines = [`🌙 Workazy · ${currentTime()}`, `Выполнено ${completedCount} из ${dayTasks.length}`];

  if (!dayTasks.length && !dayEvents.length) {
    lines.push("", "На сегодня задач и событий нет.");
    return lines.join("\n");
  }

  if (pendingTasks.length) {
    lines.push("", "Не выполнено:", ...formatList(pendingTasks.map((task) => `• ${task.title}`)));
  } else if (dayTasks.length) {
    lines.push("", "Все задачи на сегодня выполнены ✅");
  }

  if (dayEvents.length) {
    lines.push("", "События сегодня:", ...formatList(dayEvents.map((event) => `• ${event.time ? `${event.time} ` : ""}${event.title}`)));
  }
  return lines.join("\n");
}

function parseDigestPayload(raw: string | null): { hash?: string; date?: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as { hash?: string; date?: string };
  } catch {
    return null;
  }
}

export const POST = withApi(async (request) => {
  const url = new URL(request.url);
  const force = readQueryBool(url.searchParams.get("force"), "force") ?? false;
  const date = todayDate();
  const db = await getDb();

  const [dayTasks, dayEvents] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.date, date)).orderBy(asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(eq(calendarEvents.date, date)).orderBy(asc(calendarEvents.time)),
  ]);

  const pendingTasks = dayTasks.filter((task) => !task.completed);
  const hash = digestHash(dayTasks, dayEvents);
  const digestLog = { entityType: DIGEST_ENTITY, entityId: DIGEST_ID, dueAt: nowIso(), payload: JSON.stringify({ hash, date }) } as const;

  if (!force) {
    const lastRows = await db
      .select()
      .from(reminderLogs)
      .where(and(eq(reminderLogs.entityType, DIGEST_ENTITY), eq(reminderLogs.entityId, DIGEST_ID), eq(reminderLogs.status, "sent")))
      .orderBy(desc(reminderLogs.dueAt))
      .limit(1);
    const lastPayload = parseDigestPayload(lastRows[0]?.payload ?? null);
    if (lastPayload && lastPayload.hash === hash && lastPayload.date === date) {
      await db.insert(reminderLogs).values({ ...digestLog, status: "skipped" });
      return jsonOk({ sent: false, reason: "no_changes" });
    }
  }

  const text = buildMessage(dayTasks, dayEvents);
  try {
    await sendTelegramMessage(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(reminderLogs).values({ ...digestLog, status: "error", payload: JSON.stringify({ hash, date, error: message }) });
    throw new ApiError(502, "Не удалось отправить сообщение в Telegram");
  }

  await db.insert(reminderLogs).values({ ...digestLog, status: "sent", sentAt: nowIso() });
  return jsonOk({ sent: true, date, pending: pendingTasks.length, events: dayEvents.length });
});
