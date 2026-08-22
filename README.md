# Workazy

Личный планер: визуальный MVP, созданный в ChatGPT Sites.

Живая версия: https://personal-planner.uchepir.chatgpt.site

## Что внутри

- вкладка плана с быстрым вводом пунктов;
- цели на неделю, месяц и год;
- дневник с историей и экспортом через печать/PDF;
- календарь с задачами и событиями;
- прогресс и настройки напоминаний.

## Локальный запуск

```bash
npm install
npm run dev
```

В этот репозиторий залит основной исходный код приложения. `package-lock.json` и `public/og.png` не добавлены через ChatGPT-коннектор из-за ограничений файловой загрузки; их лучше докинуть позже обычным `git push` из локальной среды.

## Интеграция с ChatGPT (Custom GPT Actions)

ChatGPT управляет планером через REST API — без OpenAI API и без AI внутри сайта.

1. Настройки окружения воркера:
   - `WORKAZY_API_TOKEN` — статический секрет; каждый запрос должен содержать `Authorization: Bearer <токен>`;
   - биндинг D1 `DB` (настроен в `.openai/hosting.json`); миграция `db/migrations/0000_*.sql` должна быть применена к базе.
2. В GPT Builder → Actions: импортировать `https://<сайт>/openapi.json`, Authentication = Bearer, вставить тот же токен.
3. Примеры команд: «добавь задачу на завтра: …», «покажи невыполненные задачи», «отметь задачу выполненной», «запиши в дневник …», «добавь идею …», «сводка дня», «как прошла неделя».
4. Проверка вручную:

```bash
WORKAZY_BASE_URL="https://personal-planner.uchepir.chatgpt.site"
curl -H "Authorization: Bearer $WORKAZY_API_TOKEN" "$WORKAZY_BASE_URL/api/v1/health"
curl -X POST -H "Authorization: Bearer $WORKAZY_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"тест","date":"2026-08-23"}' "$WORKAZY_BASE_URL/api/v1/tasks"
```

## Telegram-бот: почасовые напоминания

Endpoint работает в том же воркере и ходит в ту же базу. GitHub Actions раз в
час вызывает `POST /api/v1/reminders/tick`, а воркер отправляет сводку дня в
Telegram — и только если картина дня изменилась с последней отправки
(анти-спам: хэш состава хранится в `reminder_logs`, `entityType="digest"`).

1. Создайте бота у @BotFather и задайте в окружении хостинга секреты
   `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`. Опубликованный токен необходимо
   сначала перевыпустить через команду `/revoke` в BotFather.
2. Напишите боту любое сообщение и узнайте свой чат:
   `curl "https://api.telegram.org/bot<ТОКЕН>/getUpdates"` → `message.chat.id`
   → секрет `TELEGRAM_CHAT_ID`.
3. Добавьте `WORKAZY_API_TOKEN` в GitHub → Settings → Secrets and variables →
   Actions. Ежечасный workflow уже находится в
   `.github/workflows/hourly-reminder.yml`:

```yaml
on:
  schedule:
    - cron: "0 * * * *"
jobs:
  reminder:
    runs-on: ubuntu-latest
    steps:
      - run: >
          curl -sf -X POST
          -H "Authorization: Bearer ${{ secrets.WORKAZY_API_TOKEN }}"
          https://personal-planner.uchepir.chatgpt.site/api/v1/reminders/tick
```

4. Проверка: `POST /api/v1/reminders/tick?force=true` присылает сообщение даже
   без изменений; повторный вызов без `force` вернёт
   `{ "ok": true, "data": { "sent": false, "reason": "no_changes" } }`.

Команды `/today`, `/tomorrow`, `/done`, `/add`, `/summary` — второй этап:
добавится обработчик `POST /api/v1/telegram/webhook` в этом же воркере.
