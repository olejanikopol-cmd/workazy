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
