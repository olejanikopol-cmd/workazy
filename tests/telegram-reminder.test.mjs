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
  assert.match(source, /currentDigestHour\(/, "в сообщение попадает ровный часовой слот");
  assert.match(source, /buildMessage\(dayTasks, dayEvents, nextTasks, nextEvents, digestHour\)/, "Telegram-текст использует округлённое время");
  assert.match(source, /✅/, "выполненные пункты плана помечаются зелёной галочкой");
  assert.match(source, /❌/, "невыполненные пункты плана помечаются красным крестиком");
  assert.match(source, /nextDayDate/, "дайджест включает задачи и события на завтра");
  assert.match(source, /План на завтра/, "завтрашний план попадает в сообщение");
});

test("digest hash changes when visible Telegram content changes", async () => {
  const source = await readFile(new URL("app/api/v1/reminders/tick/route.ts", root), "utf8");
  const helpers = source.slice(source.indexOf("const DIGEST_ENTITY"), source.indexOf("export const POST"));
  const output = ts.transpileModule(`${helpers}\nexport { digestHash };`, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const digest = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const tasks = [{ id: "task-1", title: "Первая задача", completed: false }];
  const events = [{ id: "event-1", title: "Созвон", time: "12:00" }];
  const nextTasks = [{ id: "task-2", title: "Завтрашняя задача", completed: false }];
  const initial = digest.digestHash(tasks, events, nextTasks, []);

  assert.notEqual(initial, digest.digestHash([{ ...tasks[0], title: "Новый текст" }], events, nextTasks, []));
  assert.notEqual(initial, digest.digestHash([{ ...tasks[0], completed: true }], events, nextTasks, []));
  assert.notEqual(initial, digest.digestHash(tasks, [{ ...events[0], time: "13:00" }], nextTasks, []));
  assert.notEqual(initial, digest.digestHash(tasks, events, [], []));
});

test("telegram client uses the Bot API directly and reads secrets from env", async () => {
  const source = await readFile(new URL("lib/telegram.ts", root), "utf8");
  assert.match(source, /api\.telegram\.org\/bot/);
  assert.match(source, /TELEGRAM_BOT_TOKEN/);
  assert.match(source, /TELEGRAM_CHAT_ID/);
  assert.doesNotMatch(source, /from "openai/, "OpenAI API не используется");
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
  assert.match(source, /"task", "event", "digest"/);
});

test("hourly GitHub workflow calls the protected tick endpoint", async () => {
  const source = await readFile(new URL(".github/workflows/hourly-reminder.yml", root), "utf8");
  const proxy = await readFile(new URL("app/api/telegram/hourly/route.ts", root), "utf8");
  assert.match(source, /cron: "0 \* \* \* \*"/);
  assert.match(source, /id-token: write/);
  assert.match(source, /core\.getIDToken\('workazy-hourly'\)/);
  assert.match(source, /api\/telegram\/hourly/);
  assert.match(proxy, /verifyGithubActionsRequest/);
  assert.match(proxy, /api\/v1\/reminders\/tick/);
});
