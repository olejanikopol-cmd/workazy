export const dynamic = "force-dynamic";

// Точные уведомления о событиях и финансовых сроках плюс почасовой дайджест:
// незакрытые хвосты прошлых дней, задачи и события на сегодня и завтра.
// ✅ — выполненные пункты плана, ❌ — невыполненные.
// Анти-дублирование: сообщение отправляется ровно один раз за час,
// даже если внешний планировщик повторит запрос.
// Внешний планировщик вызывает каждые 5 минут: POST /api/v1/reminders/tick.
import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, reminderLogs, settings, tasks } from "@/db/schema";
import { ApiError, jsonOk, nowIso, readQueryBool, todayDate, withApi } from "@/lib/api";
import { FINANCE_STATE_KEY, normalizeFinanceState } from "@/lib/finance";
import { collectDueTelegramNotifications, type DueTelegramNotification } from "@/lib/reminder-scheduler";
import { sendTelegramMessage } from "@/lib/telegram";

const DIGEST_ENTITY = "digest";
const DIGEST_ID = "hourly";
const LIST_LIMIT = 15;
const OVERDUE_QUERY_LIMIT = 100;
const TELEGRAM_TEXT_LIMIT = 3900;
const STALE_LOCK_MS = 3 * 60 * 1000;

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

async function reserveTelegramSlot(
  db: Awaited<ReturnType<typeof getDb>>,
  lockKey: string,
  now: Date,
): Promise<boolean> {
  const reservedAt = now.toISOString();
  const inserted = await db
    .insert(settings)
    .values({ key: lockKey, value: "sending", updatedAt: reservedAt })
    .onConflictDoNothing()
    .returning({ key: settings.key });
  if (inserted.length) return true;

  // Если воркер оборвался после захвата lock, значение могло навсегда остаться
  // в состоянии sending. Повторный запуск через несколько минут безопасно
  // забирает только тот же самый устаревший lock; sent никогда не трогаем.
  const [existing] = await db
    .select({ value: settings.value, updatedAt: settings.updatedAt })
    .from(settings)
    .where(eq(settings.key, lockKey))
    .limit(1);
  if (!existing || existing.value !== "sending") return false;
  if (existing.updatedAt > new Date(now.getTime() - STALE_LOCK_MS).toISOString()) return false;

  const reclaimed = await db
    .update(settings)
    .set({ updatedAt: reservedAt })
    .where(and(
      eq(settings.key, lockKey),
      eq(settings.value, "sending"),
      eq(settings.updatedAt, existing.updatedAt),
    ))
    .returning({ key: settings.key });
  return reclaimed.length > 0;
}

function storedObligations(value: string | undefined) {
  if (!value) return [];
  try {
    return normalizeFinanceState(JSON.parse(value)).obligations;
  } catch {
    return [];
  }
}

async function deliverDueNotifications(
  db: Awaited<ReturnType<typeof getDb>>,
  notifications: DueTelegramNotification[],
  now: Date,
) {
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const notification of notifications) {
    const lockKey = `telegram-due:${notification.entityType}:${notification.entityId}:${notification.dueAt}`;
    const reserved = await reserveTelegramSlot(db, lockKey, now);
    if (!reserved) {
      skipped += 1;
      continue;
    }

    const log = {
      entityType: notification.entityType,
      entityId: notification.entityId,
      dueAt: notification.dueAt,
      payload: JSON.stringify({ source: "scheduled" }),
    } as const;
    try {
      await sendTelegramMessage(notification.text);
      await db.update(settings).set({ value: "sent", updatedAt: nowIso() }).where(eq(settings.key, lockKey));
      await db.insert(reminderLogs).values({ ...log, status: "sent", sentAt: nowIso() });
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.insert(reminderLogs).values({ ...log, status: "error", payload: JSON.stringify({ source: "scheduled", error: message }) });
      await db.delete(settings).where(eq(settings.key, lockKey));
      errors.push(`${notification.entityType}:${notification.entityId}: ${message}`);
    }
  }

  return { sent, skipped, errors };
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

  const [overdueTasks, dayTasks, dayEvents, nextTasks, nextEvents, reminderEvents, financeRows] = await Promise.all([
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
    db.select().from(calendarEvents)
      .where(and(gte(calendarEvents.date, previousDate), lte(calendarEvents.date, nextDate)))
      .orderBy(asc(calendarEvents.date), asc(calendarEvents.time)),
    db.select({ value: settings.value }).from(settings).where(eq(settings.key, FINANCE_STATE_KEY)).limit(1),
  ]);

  const timeZone = process.env.WORKAZY_TIME_ZONE ?? "Europe/Kyiv";
  const dueNotifications = collectDueTelegramNotifications({
    events: reminderEvents,
    obligations: storedObligations(financeRows[0]?.value),
    now,
    timeZone,
  });
  const due = await deliverDueNotifications(db, dueNotifications, now);
  if (due.errors.length) {
    throw new ApiError(502, `Не удалось отправить запланированное уведомление в Telegram: ${due.errors[0]}`);
  }

  const pendingTasks = dayTasks.filter((task) => !task.completed);
  const yesterdayPending = overdueTasks.filter((task) => task.date === previousDate).length;
  const hash = digestHash(overdueTasks, dayTasks, dayEvents, nextTasks, nextEvents);
  const digestLog = { entityType: DIGEST_ENTITY, entityId: `${DIGEST_ID}:${hourBucket}`, dueAt: nowIso(), payload: JSON.stringify({ hash, date, previousDate, hourBucket, digestHour }) } as const;

  if (!force) {
    const reserved = await reserveTelegramSlot(db, lockKey, now);
    if (!reserved) {
      await db.insert(reminderLogs).values({ ...digestLog, status: "skipped" });
      return jsonOk({ sent: false, reason: "already_sent_this_hour", due });
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
    due,
  });
});
