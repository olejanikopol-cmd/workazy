# Workazy Rules

Workazy — личный планер в минималистичном тёмном стиле Apple / Monobank.

## Правила
- Не переписывать весь проект без причины.
- Делать маленькие изменения.
- Не менять общий дизайн без отдельной задачи.
- Не добавлять backend и авторизацию без отдельного решения.
- Сейчас данные хранятся в localStorage.
- Локальный запуск: npm run dev.
- После изменений проверять npm run build.

## Структура
- app/planner-app.tsx — главный экран
- app/secondary-screens.tsx — цели, дневник, календарь, прогресс
- app/journal-media.tsx — запись, черновики и плееры аудио/видео дневника
- app/globals.css — стили
- lib/types.ts — типы данных
- lib/planner-storage.ts — localStorage
- lib/journal-media.ts — серверный слой медиа (метаданные в D1, файлы в R2)
- lib/r2.ts, lib/media-sign.ts — R2-хранилище и подписанные ссылки
- lib/transcription/ — расшифровка речи (провайдер Groq)
- lib/zip.ts, lib/journal-export.ts — бэкап и экспорт дневника