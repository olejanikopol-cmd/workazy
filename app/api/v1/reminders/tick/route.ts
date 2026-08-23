export const dynamic = "force-dynamic";

// Почасовой дайджест для Telegram-бота:
// невыполненные задачи на сегодня + события на сегодня + прогресс дня.
// Анти-дублирование: сообщение отправляется ровно один раз за час,
// даже если внешний планировщик повторит запрос.
// Внешний планировщик вызывает раз в час: POST /api/v1/reminders/tick.
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, reminderLogs, settings, tasks } from "@/db/schema";
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

function currentDigestHour(now: Date): string {
  const timeZone = process.env.WORKAZY_TIME_ZONE ?? "Europe/Kyiv";
  try {
    const hour = new Intl.DateTimeFormat("en", { timeZone, hour: "2-digit", hour12: false }).format(now);
    return `${hour === "24" ? "00" : hour}:00`;
  } catch {
    return `${String(now.getHours()).padStart(2, "0")}:00`;
  }
}

function currentHourBucket(now: Date): string {
  const timeZone = process.env.WORKAZY_TIME_ZONE ?? "Europe/Kyiv";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}`;
  } catch {
    return now.toISOString().slice(0, 13);
  }
}

function formatList(items: string[]): string[] {
  const lines = items.slice(0, LIST_LIMIT);
  if (items.length > LIST_LIMIT) lines.push(`…и ещё ${items.length - LIST_LIMIT}`);
  return lines;
}

function buildMessage(dayTasks: DigestTask[], dayEvents: DigestEvent[], digestHour: string): string {
  const completedCount = dayTasks.filter((task) => task.completed).length;
  const pendingTasks = dayTasks.filter((task) => !task.completed);
  const lines = [`🌙 Workazy · ${digestHour}`, `Выполнено ${completedCount} из ${dayTasks.length}`];

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

export const POST = withApi(async (request) => {
  const url = new URL(request.url);
  const force = readQueryBool(url.searchParams.get("force"), "force") ?? false;
  const now = new Date();
  const date = todayDate(now);
  const hourBucket = currentHourBucket(now);
  const digestHour = currentDigestHour(now);
  const lockKey = `telegram-hour:${hourBucket}`;
  const db = await getDb();

  const [dayTasks, dayEvents] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.date, date)).orderBy(asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(eq(calendarEvents.date, date)).orderBy(asc(calendarEvents.time)),
  ]);

  const pendingTasks = dayTasks.filter((task) => !task.completed);
  const hash = digestHash(dayTasks, dayEvents);
  const digestLog = { entityType: DIGEST_ENTITY, entityId: `${DIGEST_ID}:${hourBucket}`, dueAt: nowIso(), payload: JSON.stringify({ hash, date, hourBucket, digestHour }) } as const;

  if (!force) {
    const reserved = await db
      .insert(settings)
      .values({ key: lockKey, value: "sending", updatedAt: nowIso() })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (!reserved.length) {
      await db.insert(reminderLogs).values({ ...digestLog, status: "skipped" });
      return jsonOk({ sent: false, reason: "already_sent_this_hour" });
    }
  }

  const text = buildMessage(dayTasks, dayEvents, digestHour);
  try {
    await sendTelegramMessage(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(reminderLogs).values({ ...digestLog, status: "error", payload: JSON.stringify({ hash, date, hourBucket, digestHour, error: message }) });
    if (!force) await db.delete(settings).where(eq(settings.key, lockKey));
    throw new ApiError(502, "Не удалось отправить сообщение в Telegram");
  }

  if (!force) {
    await db.update(settings).set({ value: "sent", updatedAt: nowIso() }).where(eq(settings.key, lockKey));
  }
  await db.insert(reminderLogs).values({ ...digestLog, status: "sent", sentAt: nowIso() });
  return jsonOk({ sent: true, date, hour: digestHour, pending: pendingTasks.length, events: dayEvents.length });
});
