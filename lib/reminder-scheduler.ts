import type { CalendarEvent, FinanceObligation } from "./types";

export const DEFAULT_OBLIGATION_REMINDER_TIME = "09:00";
export const REMINDER_CATCH_UP_MS = 24 * 60 * 60 * 1000;

export type DueTelegramNotification = {
  entityType: "event" | "obligation";
  entityId: string;
  dueAt: string;
  text: string;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function formatterParts(date: Date, timeZone: string): DateParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
  } catch {
    return null;
  }
}

function parseLocalDateTime(date: string, time: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match || !timeMatch) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    check.getUTCFullYear() !== parts.year
    || check.getUTCMonth() !== parts.month - 1
    || check.getUTCDate() !== parts.day
  ) return null;
  return parts;
}

function sameParts(left: DateParts, right: DateParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

/** Converts a wall-clock date/time in an IANA zone to a UTC instant. */
export function zonedDateTimeToUtc(date: string, time: string, timeZone: string): Date | null {
  const target = parseLocalDateTime(date, time);
  if (!target) return null;
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let guess = targetAsUtc;

  // Offset iteration works across DST without hard-coding Kyiv's UTC offset.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const displayed = formatterParts(new Date(guess), timeZone);
    if (!displayed) return null;
    const displayedAsUtc = Date.UTC(displayed.year, displayed.month - 1, displayed.day, displayed.hour, displayed.minute);
    const correction = targetAsUtc - displayedAsUtc;
    if (correction === 0) break;
    guess += correction;
  }

  const result = new Date(guess);
  const displayed = formatterParts(result, timeZone);
  return displayed && sameParts(displayed, target) ? result : null;
}

export function parseReminderMinutes(reminder?: string | null): number | null {
  const normalized = reminder?.trim().toLocaleLowerCase("ru-RU") ?? "";
  if (!normalized || normalized === "не напоминать") return null;
  if (normalized === "в момент события") return 0;

  const minuteMatch = /^за\s+(\d+)\s+мин/.exec(normalized);
  if (minuteMatch) return Math.min(Number(minuteMatch[1]), 7 * 24 * 60);
  const hourMatch = /^за\s+(\d+)\s+час/.exec(normalized);
  if (hourMatch) return Math.min(Number(hourMatch[1]) * 60, 7 * 24 * 60);
  const dayMatch = /^за\s+(\d+)\s+д/.exec(normalized);
  if (dayMatch) return Math.min(Number(dayMatch[1]) * 24 * 60, 7 * 24 * 60);
  return null;
}

export function calendarEventDueAt(
  event: Pick<CalendarEvent, "date" | "time" | "reminder">,
  timeZone: string,
): Date | null {
  if (!event.time) return null;
  const minutes = parseReminderMinutes(event.reminder);
  if (minutes === null) return null;
  const startsAt = zonedDateTimeToUtc(event.date, event.time, timeZone);
  return startsAt ? new Date(startsAt.getTime() - minutes * 60 * 1000) : null;
}

export function calendarEventStartsAt(
  event: Pick<CalendarEvent, "date" | "time">,
  timeZone: string,
): Date | null {
  return event.time ? zonedDateTimeToUtc(event.date, event.time, timeZone) : null;
}

export function obligationDueAt(
  obligation: Pick<FinanceObligation, "dueDate" | "reminderTime">,
  timeZone: string,
): Date | null {
  if (!obligation.dueDate) return null;
  return zonedDateTimeToUtc(
    obligation.dueDate,
    obligation.reminderTime ?? DEFAULT_OBLIGATION_REMINDER_TIME,
    timeZone,
  );
}

function localDate(now: Date, timeZone: string): string {
  const parts = formatterParts(now, timeZone);
  if (!parts) return now.toISOString().slice(0, 10);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function eventDayLabel(eventDate: string, now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  if (eventDate === today) return "СЕГОДНЯ";
  if (eventDate === shiftDate(today, 1)) return "ЗАВТРА";
  const [, month, day] = eventDate.split("-");
  return `${day}.${month}`;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
}

export function buildCalendarTelegramText(
  event: Pick<CalendarEvent, "title" | "date" | "time" | "note">,
  now: Date,
  timeZone: string,
): string {
  const title = event.title.trim().toLocaleUpperCase("ru-RU");
  const when = `${eventDayLabel(event.date, now, timeZone)}${event.time ? ` В ${event.time}` : ""}`;
  const lines = [`⚠️ ВНИМАНИЕ! У ТЕБЯ ${when} ${title}`];
  if (event.note?.trim()) lines.push("", event.note.trim());
  return lines.join("\n");
}

export function buildObligationTelegramText(
  obligation: Pick<FinanceObligation, "kind" | "title" | "amount">,
): string {
  const title = obligation.title.trim().toLocaleUpperCase("ru-RU");
  if (obligation.kind === "debt") {
    return `💸 НАДО ОТДАТЬ ДЕНЬГИ: ${title}\nСумма: ${formatMoney(obligation.amount)} ₴\nСрок: сегодня`;
  }
  return `🛒 НАДО КУПИТЬ: ${title}\nБюджет: ${formatMoney(obligation.amount)} ₴\nСрок: сегодня`;
}

function isDue(dueAt: Date, now: Date, catchUpMs: number): boolean {
  const dueTime = dueAt.getTime();
  return dueTime <= now.getTime() && dueTime > now.getTime() - catchUpMs;
}

export function collectDueTelegramNotifications({
  events,
  obligations,
  now,
  timeZone,
  catchUpMs = REMINDER_CATCH_UP_MS,
}: {
  events: Array<Pick<CalendarEvent, "id" | "title" | "date" | "time" | "note" | "reminder">>;
  obligations: Array<Pick<FinanceObligation, "id" | "kind" | "title" | "amount" | "dueDate" | "reminderTime" | "completed">>;
  now: Date;
  timeZone: string;
  catchUpMs?: number;
}): DueTelegramNotification[] {
  const notifications: DueTelegramNotification[] = [];
  for (const event of events) {
    const startsAt = calendarEventStartsAt(event, timeZone);
    if (!startsAt) continue;

    // The selected lead time is an additional alert. Do not replay a missed
    // advance alert once the event itself has begun; the start alert below is
    // the useful notification at that point.
    const advanceDueAt = calendarEventDueAt(event, timeZone);
    if (
      advanceDueAt
      && advanceDueAt.getTime() < startsAt.getTime()
      && now.getTime() < startsAt.getTime()
      && isDue(advanceDueAt, now, catchUpMs)
    ) {
      notifications.push({
        entityType: "event",
        entityId: event.id,
        dueAt: advanceDueAt.toISOString(),
        text: buildCalendarTelegramText(event, now, timeZone),
      });
    }

    // Every timed event also receives its own independent alert at start time.
    // Its different dueAt value gives it a separate anti-duplicate lock.
    if (isDue(startsAt, now, catchUpMs)) {
      notifications.push({
        entityType: "event",
        entityId: event.id,
        dueAt: startsAt.toISOString(),
        text: buildCalendarTelegramText(event, now, timeZone),
      });
    }
  }
  for (const obligation of obligations) {
    if (obligation.completed) continue;
    const dueAt = obligationDueAt(obligation, timeZone);
    if (!dueAt || !isDue(dueAt, now, catchUpMs)) continue;
    notifications.push({
      entityType: "obligation",
      entityId: obligation.id,
      dueAt: dueAt.toISOString(),
      text: buildObligationTelegramText(obligation),
    });
  }
  return notifications.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}
