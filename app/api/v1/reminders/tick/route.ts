export const dynamic = "force-dynamic";

// Почасовой дайджест для Telegram-бота:
// незакрытые хвосты прошлых дней, задачи и события на сегодня и завтра.
// ✅ — выполненные пункты плана, ❌ — невыполненные.
// Анти-дублирование: сообщение отправляется ровно один раз за час,
// даже если внешний планировщик повторит запрос.
// Внешний планировщик вызывает раз в час: POST /api/v1/reminders/tick.
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, reminderLogs, settings, tasks } from "@/db/schema";
import { ApiError, jsonOk, nowIso, readQueryBool, todayDate, withApi } from "@/lib/api";
import { sendTelegramMessage } from "@/lib/telegram";

const DIGEST_ENTITY = "digest";
const DIGEST_ID = "hourly";
const LIST_LIMIT = 15;
const OVERDUE_QUERY_LIMIT = 100;
const TELEGRAM_TEXT_LIMIT = 3900;

type DigestTask = { id: string; title: string; date: string; completed: boolean };
type DigestEvent = { id: string; title: string; time: string | null };

function digestHash(overdueTasks: DigestTask[], dayTasks: DigestTask[], dayEvents: DigestEvent[], nextTasks: DigestTask[], nextEvents: DigestEvent[]): string {
  const input = JSON.stringify({
    overdueTasks: overdueTasks.map(({ id, title, date }) => ({ id, title, date })),
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

function shiftDayDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
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

function finalizeMessage(lines: string[]): string {
  const text = lines.join("\n");
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_TEXT_LIMIT - 2).trimEnd()}\n…`;
}

function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}.${month}`;
}

function pointWord(count: number): string {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "пунктов";
  if (count % 10 === 1) return "пункт";
  if (count % 10 >= 2 && count % 10 <= 4) return "пункта";
  return "пунктов";
}

function buildMessage(
  overdueTasks: DigestTask[],
  dayTasks: DigestTask[],
  dayEvents: DigestEvent[],
  nextTasks: DigestTask[],
  nextEvents: DigestEvent[],
  digestHour: string,
  previousDate: string,
): string {
  const completedCount = dayTasks.filter((task) => task.completed).length;
  const lines = [`🌙 Workazy · ${digestHour}`];
  if (dayTasks.length) lines.push(`Выполнено ${completedCount} из ${dayTasks.length}`);

  if (!overdueTasks.length && !dayTasks.length && !dayEvents.length && !nextTasks.length && !nextEvents.length) {
    lines.push("", "Незакрытых хвостов нет. На сегодня и завтра задач и событий тоже нет.");
    return finalizeMessage(lines);
  }

  const taskLine = (task: DigestTask) => `${task.completed ? "✅" : "❌"} ${task.title}`;
  const eventLine = (event: DigestEvent) => `• ${event.time ? `${event.time} ` : ""}${event.title}`;
  const yesterdayTasks = overdueTasks.filter((task) => task.date === previousDate);
  const olderTasks = overdueTasks.filter((task) => task.date !== previousDate);

  if (yesterdayTasks.length) {
    lines.push(
      "",
      `⚠️ За вчера осталось ${yesterdayTasks.length} ${pointWord(yesterdayTasks.length)}:`,
      ...formatList(yesterdayTasks.map(taskLine)),
      `Открой план за ${shortDate(previousDate)} и отметь выполненное. Незакрытое останется в следующих напоминаниях.`,
    );
  }
  if (olderTasks.length) {
    lines.push(
      "",
      "⚠️ Старые незакрытые пункты:",
      ...formatList(olderTasks.map((task) => `❌ ${shortDate(task.date)} · ${task.title}`)),
    );
  }

  if (dayTasks.length) lines.push("", "План на сегодня:", ...formatList(dayTasks.map(taskLine)));
  if (dayEvents.length) lines.push("", "События сегодня:", ...formatList(dayEvents.map(eventLine)));
  if (nextTasks.length) lines.push("", "План на завтра:", ...formatList(nextTasks.map(taskLine)));
  if (nextEvents.length) lines.push("", "События завтра:", ...formatList(nextEvents.map(eventLine)));
  if (!nextTasks.length && !nextEvents.length) lines.push("", "На завтра пока ничего нет.");
  return finalizeMessage(lines);
}

export const POST = withApi(async (request) => {
  const url = new URL(request.url);
  const force = readQueryBool(url.searchParams.get("force"), "force") ?? false;
  const now = new Date();
  const date = todayDate(now);
  const previousDate = shiftDayDate(date, -1);
  const nextDate = shiftDayDate(date, 1);
  const hourBucket = currentHourBucket(now);
  const digestHour = currentDigestHour(now);
  const lockKey = `telegram-hour:${hourBucket}`;
  const db = await getDb();

  const [overdueTasks, dayTasks, dayEvents, nextTasks, nextEvents] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(lt(tasks.date, date), eq(tasks.completed, false)))
      .orderBy(desc(tasks.date), asc(tasks.position), asc(tasks.createdAt))
      .limit(OVERDUE_QUERY_LIMIT),
    db.select().from(tasks).where(eq(tasks.date, date)).orderBy(asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(eq(calendarEvents.date, date)).orderBy(asc(calendarEvents.time)),
    db.select().from(tasks).where(eq(tasks.date, nextDate)).orderBy(asc(tasks.position), asc(tasks.createdAt)),
    db.select().from(calendarEvents).where(eq(calendarEvents.date, nextDate)).orderBy(asc(calendarEvents.time)),
  ]);

  const pendingTasks = dayTasks.filter((task) => !task.completed);
  const yesterdayPending = overdueTasks.filter((task) => task.date === previousDate).length;
  const hash = digestHash(overdueTasks, dayTasks, dayEvents, nextTasks, nextEvents);
  const digestLog = { entityType: DIGEST_ENTITY, entityId: `${DIGEST_ID}:${hourBucket}`, dueAt: nowIso(), payload: JSON.stringify({ hash, date, previousDate, hourBucket, digestHour }) } as const;

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

  const text = buildMessage(overdueTasks, dayTasks, dayEvents, nextTasks, nextEvents, digestHour, previousDate);
  try {
    await sendTelegramMessage(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(reminderLogs).values({ ...digestLog, status: "error", payload: JSON.stringify({ hash, date, previousDate, hourBucket, digestHour, error: message }) });
    if (!force) await db.delete(settings).where(eq(settings.key, lockKey));
    throw new ApiError(502, "Не удалось отправить сообщение в Telegram");
  }

  if (!force) {
    await db.update(settings).set({ value: "sent", updatedAt: nowIso() }).where(eq(settings.key, lockKey));
  }
  await db.insert(reminderLogs).values({ ...digestLog, status: "sent", sentAt: nowIso() });
  return jsonOk({
    sent: true,
    date,
    hour: digestHour,
    pending: pendingTasks.length,
    overdue: overdueTasks.length,
    yesterdayPending,
    events: dayEvents.length,
    tomorrowTasks: nextTasks.length,
    tomorrowEvents: nextEvents.length,
  });
});
