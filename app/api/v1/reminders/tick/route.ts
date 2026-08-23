export const dynamic = "force-dynamic";

// Почасовой дайджест для Telegram-бота:
// задачи и события на сегодня и завтра + прогресс дня.
// ✅ — выполненные пункты плана, ❌ — невыполненные.
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

function digestHash(dayTasks: DigestTask[], dayEvents: DigestEvent[], nextTasks: DigestTask[], nextEvents: DigestEvent[]): string {
  const input = JSON.stringify({
    tasks: dayTasks.map(({ id, title, completed }) => ({ id, title, completed })),
    events: dayEvents.map(({ id, title, time }) => ({ id, title, time })),
    nextTasks: nextTasks.map(({ id, title, completed }) => ({ id, title, completed })),
    nextEvents: nextEvents.map(({ id, title, time }) => ({ id, title, time })),
  });
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
}

// Завтрашняя дата в формате YYYY-MM-DD, исходя из сегодняшней даты планера.
function nextDayDate(date: string): string {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + 1);
  const month = String(next.getMonth() + 1).padStart(2, "0");
  const day = String(next.getDate()).padStart(2, "0");
  return `${next.getFullYear()}-${month}-${day}`;
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

function buildMessage(dayTasks: DigestTask[], dayEvents: DigestEvent[], nextTasks: DigestTask[], nextEvents: DigestEvent[], digestHour: string): string {
  const completedCount = dayTasks.filter((task) => task.completed).length;
  const lines = [`🌙 Workazy · ${digestHour}`];
  if (dayTasks.length) lines.push(`Выполнено ${completedCount} из ${dayTasks.length}`);

  if (!dayTasks.length && !dayEvents.length && !nextTasks.length && !nextEvents.length) {
    lines.push("", "На сегодня и завтра задач и событий нет.");
    return lines.join("\n");
  }

  const taskLine = (task: DigestTask) => `${task.completed ? "✅" : "❌"} ${task.title}`;
  const eventLine = (event: DigestEvent) => `• ${event.time ? `${event.time} ` : ""}${event.title}`;

  if (dayTasks.length) lines.push("", "План на сегодня:", ...formatList(dayTasks.map(taskLine)));
  if (dayEvents.length) lines.push("", "События сегодня:", ...formatList(dayEvents.map(eventLine)));
  if (nextTasks.length) lines.push("", "План на завтра:", ...formatList(nextTasks.map(taskLine)));
  if (nextEvents.length) lines.push("", "События завтра:", ...formatList(nextEvents.map(eventLine)));
  return lines.join("\n");
}

export const POST = withApi(async (request) => {
  const url = new URL(request.url);
  const force = readQueryBool(url.searchParams.get("force"), "force") ?? false;
  const now = new Date();
  const date = todayDate(now);
  const nextDate = nextDayDate(date);
  const hourBucket = currentHourBucket(now);
  const digestHour = currentDigestHour(now);
  const lockKey = `telegram-hour:${hourBucket}`;
  const db = await getDb();

  const [dayTasks, dayEvents, nextTasks, nextEvents] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.date, date)).orderBy(asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(eq(calendarEvents.date, date)).orderBy(asc(calendarEvents.time)),
    db.select().from(tasks).where(eq(tasks.date, nextDate)).orderBy(asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(eq(calendarEvents.date, nextDate)).orderBy(asc(calendarEvents.time)),
  ]);

  const pendingTasks = dayTasks.filter((task) => !task.completed);
  const hash = digestHash(dayTasks, dayEvents, nextTasks, nextEvents);
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

  const text = buildMessage(dayTasks, dayEvents, nextTasks, nextEvents, digestHour);
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
  return jsonOk({ sent: true, date, hour: digestHour, pending: pendingTasks.length, events: dayEvents.length, tomorrowTasks: nextTasks.length, tomorrowEvents: nextEvents.length });
});
