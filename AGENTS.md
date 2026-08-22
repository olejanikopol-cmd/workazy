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
- app/globals.css — стили
- lib/types.ts — типы данных
- lib/planner-storage.ts — localStorage