import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url);

test("telegram digest route deduplicates by stored hash and logs every outcome", async () => {
  const source = await readFile(new URL("app/api/v1/reminders/tick/route.ts", root), "utf8");
  assert.match(source, /withApi\(/, "tick защищён общим API-токеном");
  assert.match(source, /status: "skipped"/, "неизменённый дайджест помечается пропущенным");
  assert.match(source, /status: "sent"/, "успешная отправка логируется");
  assert.match(source, /sentAt: nowIso\(\)/, "успешная отправка получает sentAt");
  assert.match(source, /status: "error"/, "ошибка Telegram логируется");
  assert.match(source, /sendTelegramMessage\(/, "отправка идёт через общий клиент");
  assert.match(source, /currentHourBucket\(/, "каждый час получает отдельный lock bucket");
  assert.match(source, /onConflictDoNothing/, "повторный запуск в том же часе не дублирует отправку");
  assert.match(source, /STALE_LOCK_MS/, "зависший sending-lock можно безопасно восстановить");
  assert.match(source, /eq\(settings\.updatedAt, existing\.updatedAt\)/, "устаревший lock забирается атомарно");
  assert.match(source, /collectDueTelegramNotifications/, "тик проверяет точные напоминания календаря и финансов");
  assert.match(source, /telegram-due:/, "для каждого срока хранится отдельный антидубль lock");
  assert.match(source, /FINANCE_STATE_KEY/, "финансовые сроки читаются из серверного состояния");
  assert.match(source, /currentDigestHour\(/, "в сообщение попадает ровный часовой слот");
  assert.match(source, /buildMessage\(overdueTasks, dayTasks, dayEvents, nextTasks, nextEvents, digestHour, previousDate\)/, "Telegram-текст использует хвосты и округлённое время");
  assert.match(source, /✅/, "выполненные пункты плана помечаются зелёной галочкой");
  assert.match(source, /❌/, "невыполненные пункты плана помечаются красным крестиком");
  assert.match(source, /shiftDayDate\(date, -1\)/, "дайджест включает незакрытые задачи прошлых дней");
  assert.match(source, /lt\(tasks\.date, date\)/, "старые хвосты не исчезают через сутки");
  assert.match(source, /eq\(tasks\.completed, false\)/, "в хвосты попадают только незавершённые задачи");
  assert.match(source, /За вчера осталось/, "вчерашние хвосты выделены отдельно");
  assert.match(source, /План на завтра/, "завтрашний план попадает в сообщение");
});

test("digest hash changes when visible Telegram content changes", async () => {
  const source = await readFile(new URL("app/api/v1/reminders/tick/route.ts", root), "utf8");
  const helpers = source.slice(source.indexOf("const DIGEST_ENTITY"), source.indexOf("export const POST"));
  const output = ts.transpileModule(`${helpers}\nexport { buildMessage, digestHash, shiftDayDate };`, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const digest = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const overdue = [{ id: "task-old", title: "Вчерашняя задача", date: "2026-08-23", completed: false }];
  const tasks = [{ id: "task-1", title: "Первая задача", date: "2026-08-24", completed: false }];
  const events = [{ id: "event-1", title: "Созвон", time: "12:00" }];
  const nextTasks = [{ id: "task-2", title: "Завтрашняя задача", date: "2026-08-25", completed: false }];
  const initial = digest.digestHash(overdue, tasks, events, nextTasks, []);

  assert.notEqual(initial, digest.digestHash([{ ...overdue[0], title: "Другой хвост" }], tasks, events, nextTasks, []));
  assert.notEqual(initial, digest.digestHash(overdue, [{ ...tasks[0], title: "Новый текст" }], events, nextTasks, []));
  assert.notEqual(initial, digest.digestHash(overdue, [{ ...tasks[0], completed: true }], events, nextTasks, []));
  assert.notEqual(initial, digest.digestHash(overdue, tasks, [{ ...events[0], time: "13:00" }], nextTasks, []));
  assert.notEqual(initial, digest.digestHash(overdue, tasks, events, [], []));

  assert.equal(digest.shiftDayDate("2026-03-01", -1), "2026-02-28");
  assert.equal(digest.shiftDayDate("2026-12-31", 1), "2027-01-01");
  const text = digest.buildMessage(overdue, tasks, events, nextTasks, [], "00:00", "2026-08-23");
  assert.match(text, /За вчера осталось 1 пункт/);
  assert.match(text, /Открой план за 23\.08/);
  assert.match(text, /План на завтра:[\s\S]*Завтрашняя задача/);
  const longText = digest.buildMessage(
    Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}`, title: "Длинный хвост ".repeat(30), date: "2026-08-22", completed: false })),
    tasks,
    events,
    nextTasks,
    [],
    "00:00",
    "2026-08-23",
  );
  assert.ok(longText.length <= 3900, "дайджест помещается в одно Telegram-сообщение");
});

test("telegram client uses the Bot API directly and reads secrets from env", async () => {
  const source = await readFile(new URL("lib/telegram.ts", root), "utf8");
  assert.match(source, /api\.telegram\.org\/bot/);
  assert.match(source, /TELEGRAM_BOT_TOKEN/);
  assert.match(source, /TELEGRAM_CHAT_ID/);
  assert.doesNotMatch(source, /from "openai/, "OpenAI API не используется");
});

test("calendar and finance reminders use Kyiv wall-clock time", async () => {
  const source = await readFile(new URL("lib/reminder-scheduler.ts", root), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const scheduler = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

  assert.equal(scheduler.parseReminderMinutes("За 10 минут"), 10);
  assert.equal(scheduler.parseReminderMinutes("За 30 минут"), 30);
  assert.equal(scheduler.parseReminderMinutes("За 1 час"), 60);
  assert.equal(scheduler.parseReminderMinutes("Не напоминать"), null);

  assert.equal(
    scheduler.calendarEventDueAt({ date: "2026-09-07", time: "18:00", reminder: "За 30 минут" }, "Europe/Kyiv").toISOString(),
    "2026-09-07T14:30:00.000Z",
    "летом 17:30 по Киеву соответствует 14:30 UTC",
  );
  assert.equal(
    scheduler.calendarEventDueAt({ date: "2026-12-07", time: "18:00", reminder: "За 1 час" }, "Europe/Kyiv").toISOString(),
    "2026-12-07T15:00:00.000Z",
    "зимой смещение Киева пересчитывается автоматически",
  );
  assert.equal(
    scheduler.obligationDueAt({ dueDate: "2026-09-07" }, "Europe/Kyiv").toISOString(),
    "2026-09-07T06:00:00.000Z",
    "финансовый срок без времени приходит в 09:00 по Киеву",
  );
});

test("due reminder messages match the requested urgent format", async () => {
  const source = await readFile(new URL("lib/reminder-scheduler.ts", root), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const scheduler = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const now = new Date("2026-09-07T14:30:20.000Z");
  const notifications = scheduler.collectDueTelegramNotifications({
    events: [{ id: "event-1", title: "Собеседование", date: "2026-09-07", time: "18:00", reminder: "За 30 минут" }],
    obligations: [
      { id: "debt-1", kind: "debt", title: "Олег", amount: 500, dueDate: "2026-09-07", reminderTime: "17:30", completed: false },
      { id: "purchase-1", kind: "purchase", title: "Ноутбук", amount: 40000, dueDate: "2026-09-07", reminderTime: "17:30", completed: false },
      { id: "done-1", kind: "debt", title: "Закрытый долг", amount: 100, dueDate: "2026-09-07", reminderTime: "17:30", completed: true },
    ],
    now,
    timeZone: "Europe/Kyiv",
  });

  assert.equal(notifications.length, 3);
  assert.match(notifications.find((item) => item.entityType === "event").text, /ВНИМАНИЕ! У ТЕБЯ СЕГОДНЯ В 18:00 СОБЕСЕДОВАНИЕ/);
  assert.match(notifications.find((item) => item.entityId === "debt-1").text, /НАДО ОТДАТЬ ДЕНЬГИ: ОЛЕГ/);
  assert.match(notifications.find((item) => item.entityId === "purchase-1").text, /НАДО КУПИТЬ: НОУТБУК/);
});

test("a calendar event sends once in advance and once again at start time", async () => {
  const source = await readFile(new URL("lib/reminder-scheduler.ts", root), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const scheduler = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const event = { id: "event-1", title: "Собеседование", date: "2026-09-07", time: "18:00", reminder: "За 30 минут" };

  const advance = scheduler.collectDueTelegramNotifications({
    events: [event], obligations: [], now: new Date("2026-09-07T14:30:05.000Z"), timeZone: "Europe/Kyiv",
  });
  assert.equal(advance.length, 1);
  assert.equal(advance[0].dueAt, "2026-09-07T14:30:00.000Z", "первое сообщение приходит в 17:30 по Киеву");

  const atStart = scheduler.collectDueTelegramNotifications({
    events: [event], obligations: [], now: new Date("2026-09-07T15:00:05.000Z"), timeZone: "Europe/Kyiv",
  });
  assert.equal(atStart.length, 1, "после начала не отправляется запоздалый дубль предварительного сообщения");
  assert.equal(atStart[0].dueAt, "2026-09-07T15:00:00.000Z", "второе сообщение приходит в 18:00 по Киеву");

  const startOnlyEvent = { ...event, id: "event-2", reminder: "Только в момент события" };
  assert.equal(scheduler.collectDueTelegramNotifications({
    events: [startOnlyEvent], obligations: [], now: new Date("2026-09-07T14:30:05.000Z"), timeZone: "Europe/Kyiv",
  }).length, 0);
  assert.equal(scheduler.collectDueTelegramNotifications({
    events: [startOnlyEvent], obligations: [], now: new Date("2026-09-07T15:00:05.000Z"), timeZone: "Europe/Kyiv",
  }).length, 1);
});

test("every selectable lead time is additional to the event-time alert", async () => {
  const source = await readFile(new URL("lib/reminder-scheduler.ts", root), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const scheduler = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const cases = [
    { reminder: "За 10 минут", advanceUtc: "2026-09-07T14:50:00.000Z" },
    { reminder: "За 30 минут", advanceUtc: "2026-09-07T14:30:00.000Z" },
    { reminder: "За 1 час", advanceUtc: "2026-09-07T14:00:00.000Z" },
  ];

  for (const [index, item] of cases.entries()) {
    const event = { id: `event-${index}`, title: "Проверка", date: "2026-09-07", time: "18:00", reminder: item.reminder };
    const advance = scheduler.collectDueTelegramNotifications({
      events: [event], obligations: [], now: new Date(new Date(item.advanceUtc).getTime() + 5_000), timeZone: "Europe/Kyiv",
    });
    assert.deepEqual(advance.map((notification) => notification.dueAt), [item.advanceUtc], `${item.reminder} создаёт предварительное сообщение`);

    const atStart = scheduler.collectDueTelegramNotifications({
      events: [event], obligations: [], now: new Date("2026-09-07T15:00:05.000Z"), timeZone: "Europe/Kyiv",
    });
    assert.deepEqual(atStart.map((notification) => notification.dueAt), ["2026-09-07T15:00:00.000Z"], `${item.reminder} не отменяет сообщение в 18:00`);
  }
});

test("telegram config trims and validates token and chat id", async () => {
  const source = await readFile(new URL("lib/telegram.ts", root), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const telegram = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;

  try {
    process.env.TELEGRAM_BOT_TOKEN = " 123456:valid_test-token ";
    process.env.TELEGRAM_CHAT_ID = " 987654 ";
    assert.deepEqual(await telegram.getTelegramConfig(), { token: "123456:valid_test-token", chatId: "987654" });
    process.env.TELEGRAM_CHAT_ID = "not-a-chat";
    await assert.rejects(telegram.getTelegramConfig(), /неверный формат/);
  } finally {
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChatId;
  }
});

test("reminder schema supports digest entries", async () => {
  const source = await readFile(new URL("db/schema.ts", root), "utf8");
  assert.match(source, /"task", "event", "obligation", "digest"/);
});

test("GitHub keeps an authenticated exact-time reminder poller alive", async () => {
  const source = await readFile(new URL(".github/workflows/hourly-reminder.yml", root), "utf8");
  const proxy = await readFile(new URL("app/api/telegram/hourly/route.ts", root), "utf8");
  const tick = await readFile(new URL("app/api/v1/reminders/tick/route.ts", root), "utf8");
  assert.match(source, /cron: "53 \* \* \* \*"/, "часовой воркер запускается вне перегруженной нулевой минуты");
  assert.match(source, /timeout-minutes: 65/);
  assert.match(source, /pollIntervalMs = 15_000/);
  assert.match(source, /dueOnly=true/);
  assert.match(source, /cancel-in-progress: true/);
  assert.match(source, /refreshTokenAt = Date\.now\(\) \+ 4 \* 60_000/);
  assert.match(source, /exact checks will continue/);
  assert.doesNotMatch(source, /consecutiveFailures >= 5\) throw/);
  assert.doesNotMatch(source, /cron: "0 \* \* \* \*"/);
  assert.match(source, /id-token: write/);
  assert.match(source, /core\.getIDToken\("workazy-hourly"\)/);
  assert.match(source, /api\/telegram\/hourly/);
  assert.match(proxy, /verifyGithubActionsRequest/);
  assert.match(proxy, /api\/v1\/reminders\/tick/);
  assert.match(proxy, /searchParams\.set\("dueOnly", dueOnly\)/);
  assert.match(tick, /if \(dueOnly\) \{[\s\S]*return jsonOk\(\{ sent: due\.sent > 0, due \}\)/);
});

test("the Worker runs exact-time reminder ticks every minute without the public URL", async () => {
  const worker = await readFile(new URL("worker/index.ts", root), "utf8");
  const vite = await readFile(new URL("vite.config.ts", root), "utf8");
  assert.match(vite, /crons: \["\* \* \* \* \*"\]/);
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /const dueOnly = minute !== "55"/);
  assert.match(worker, /workazy\.internal\/api\/v1\/reminders\/tick/);
  assert.match(worker, /dueOnly \? "\?dueOnly=true" : ""/);
  assert.doesNotMatch(worker, /personal-planner\.uchepir\.chatgpt\.site/);
});
