# Workazy

Личный планер: визуальный MVP, созданный в ChatGPT Sites.

Живая версия: https://personal-planner.uchepir.chatgpt.site

## Что внутри

- вкладка плана с быстрым вводом пунктов;
- цели на неделю, месяц и год;
- дневник с историей, голосовыми и видеозаписями, расшифровкой речи и экспортом;
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
   - биндинг D1 `DB` (настроен в `.openai/hosting.json`); build проверяет упаковку миграций `0000`/`0001`, а защищённый `/api/v1/health` безопасно проверяет и восстанавливает пропущенную `0001` без удаления записей;
   - для голосовых и видеозаписей дневника нужен биндинг R2 `MEDIA` (уже прописан в `.openai/hosting.json`).
2. В GPT Builder → Actions: импортировать `https://<сайт>/openapi.json`, Authentication = Bearer, вставить тот же токен.
3. Примеры команд: «добавь задачу на завтра: …», «покажи невыполненные задачи», «отметь задачу выполненной», «запиши в дневник …», «добавь идею …», «сводка дня», «как прошла неделя».
4. Проверка вручную:

```bash
WORKAZY_BASE_URL="https://personal-planner.uchepir.chatgpt.site"
curl -H "Authorization: Bearer $WORKAZY_API_TOKEN" "$WORKAZY_BASE_URL/api/v1/health"
curl -X POST -H "Authorization: Bearer $WORKAZY_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"тест","date":"2026-08-23"}' "$WORKAZY_BASE_URL/api/v1/tasks"
```

## Дневник: голосовые и видеозаписи

Медиадневник работает только при включённой синхронизации: бинарные файлы
живут в облаке, а не в браузере.

- **Хранилище.** Файлы пишутся в R2 (биндинг `MEDIA` из `.openai/hosting.json`),
  в D1 хранятся только метаданные и транскрипты (таблица `journal_media`,
  миграция `0001_*.sql`). В состояние планера и в localStorage бинарные данные
  не попадают никогда.
- **Запись.** Аудио — до 15 минут / 24 МБ, видео — до 10 минут / 80 МБ.
  Видео дополнительно пишет лёгкую аудиодорожку для расшифровки и повторных
  попыток; оригинал сохраняется отдельно и целиком в Groq не отправляется.
- **Расшифровка.** Провайдер — Groq (`whisper-large-v3-turbo`, запрос напрямую
  на `api.groq.com`, официальный OpenAI API не используется). Секрет:
  `GROQ_API_KEY` в окружении хостинга. Язык не задаётся — модель сама
  распознаёт русский и украинский. Сбой расшифровки не удаляет файл: статус
  становится `error`, кнопка «Повторить» запускает расшифровку по уже
  сохранённому файлу. Транскрипт можно править вручную.
- **Воспроизведение.** Файлы приватные. Плееры получают короткоживущую
  подпись на 5 минут (HMAC поверх `WORKAZY_API_TOKEN`, сам токен в URL не
  попадает), роут `/api/v1/journal/media/:id/file` поддерживает HTTP Range.
- **Записи без текста.** Запись дневника может состоять только из аудио или
  видео: `POST /api/v1/journal` принимает пустой `body`, клиент может передать
  собственный `id` записи, к которой привязываются файлы.
- **Удаление и синхронизация.** Удаление записи удаляет её файлы из D1 и R2.
  `PUT /api/v1/state` сохраняет медиа выживших записей и вычищает файлы
  удалённых записей после успешной замены состояния.
- **Экспорт и бэкап.** Одиночная запись выгружается в Markdown/Текст/JSON,
  медиа скачиваются оригиналами. Полный бэкап — ZIP со структурой
  `journal/manifest.json`, `journal/entries/*`, `journal/transcripts/*`,
  `journal/media/*`; секреты в архив не попадают.

Медиаэндпоинты:

```bash
WORKAZY_BASE_URL="https://personal-planner.uchepir.chatgpt.site"
# метаданные вложений записи (доступно и ChatGPT-ассистенту)
curl -H "Authorization: Bearer $WORKAZY_API_TOKEN" "$WORKAZY_BASE_URL/api/v1/journal/<entry-id>/media"
# повтор расшифровки по сохранённому файлу
curl -X POST -H "Authorization: Bearer $WORKAZY_API_TOKEN" "$WORKAZY_BASE_URL/api/v1/journal/media/<media-id>/transcribe"
# короткоживущая ссылка на байты для плеера
curl -H "Authorization: Bearer $WORKAZY_API_TOKEN" "$WORKAZY_BASE_URL/api/v1/journal/media/<media-id>/file-url"
```

## Telegram-бот: напоминания по времени и почасовые сводки

Endpoint работает в том же воркере и ходит в ту же базу. Защищённый GitHub
Actions job проверяет сроки каждые пять минут, а независимый почасовой запуск
повторяет последний job как резерв. Воркер отправляет события с учётом выбранного
интервала (например, за 30 минут), а долги и покупки — в указанное в форме время
дня срока (по умолчанию 09:00, часовой пояс `Europe/Kyiv`). Почасовая сводка
по-прежнему приходит не чаще одного раза в часовом слоте. Атомарные lock-записи
хранятся в `settings`, результаты — в `reminder_logs`; повторный вызов не создаёт
дубликат уведомления.

1. Создайте бота у @BotFather и задайте в окружении хостинга секреты
   `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`. Опубликованный токен необходимо
   сначала перевыпустить через команду `/revoke` в BotFather.
2. Напишите боту любое сообщение и узнайте свой чат:
   `curl "https://api.telegram.org/bot<ТОКЕН>/getUpdates"` → `message.chat.id`
   → секрет `TELEGRAM_CHAT_ID`.
3. Защищённый OIDC-workflow находится в
   `.github/workflows/hourly-reminder.yml` и не требует копировать API-токен в
   GitHub. Расписание проверяет сроки каждые пять минут со второй минуты часа
   (это снижает риск задержки GitHub в перегруженную нулевую минуту), а серверная
   блокировка отсекает дубли:

```yaml
on:
  schedule:
    - cron: "2-59/5 * * * *"
jobs:
  reminder:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: return await core.getIDToken('workazy-hourly')
      - run: curl -sf -X POST https://personal-planner.uchepir.chatgpt.site/api/telegram/hourly
```

4. Проверка: `POST /api/v1/reminders/tick?force=true` присылает сообщение даже
   при уже занятом часовом слоте; повторный вызов без `force` вернёт
   `{ "ok": true, "data": { "sent": false, "reason": "already_sent_this_hour" } }`.

Команды `/today`, `/tomorrow`, `/done`, `/add`, `/summary` — второй этап:
добавится обработчик `POST /api/v1/telegram/webhook` в этом же воркере.
