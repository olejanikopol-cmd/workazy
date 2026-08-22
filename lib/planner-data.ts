import type { CalendarEvent, Goal, Idea, JournalEntry, PlanTask } from "./types";

export const todayIso = () => new Date().toISOString().slice(0, 10);

export const initialTasks: PlanTask[] = [
  { id: "task-1", title: "Закрыть главный экран проекта", completed: true, date: todayIso() },
  { id: "task-2", title: "2 часа сфокусированного кодинга", completed: true, date: todayIso() },
  { id: "task-3", title: "Тренировка после работы", completed: false, date: todayIso() },
  { id: "task-4", title: "Купить продукты на ужин", completed: false, date: todayIso() },
  { id: "task-5", title: "Записать мысли перед сном", completed: false, date: todayIso() },
];

export const initialGoals: Goal[] = [
  { id: "goal-1", title: "Собрать визуальный MVP планера", description: "Цель недели", period: "week", progress: 68, createdAt: "2026-08-18", deadline: "2026-08-24", completed: false },
  { id: "goal-2", title: "12 тренировок", description: "Вернуть стабильный ритм", period: "month", progress: 42, createdAt: "2026-08-01", deadline: "2026-08-31", completed: false },
  { id: "goal-3", title: "Выпустить свой первый продукт", description: "Большая цель года", period: "year", progress: 31, createdAt: "2026-01-01", deadline: "2026-12-31", completed: false },
];

export const initialEntries: JournalEntry[] = [
  { id: "entry-1", date: todayIso(), title: "Спокойный фокус", body: "Сегодня не пытался успеть всё. Выбрал две важные вещи и действительно продвинулся. Вечером стало заметно легче в голове.", mood: "Спокойно", tags: ["фокус", "работа"] },
  { id: "entry-2", date: "2026-08-20", title: "Что сработало", body: "Сделал тренировку сразу после работы, не заходя домой. Это убрало лишние переговоры с собой.", mood: "Энергично", tags: ["спорт"] },
];

export const initialEvents: CalendarEvent[] = [
  { id: "event-1", title: "Тренировка", date: todayIso(), time: "19:00", reminder: "За 30 минут" },
  { id: "event-2", title: "Созвон по проекту", date: "2026-08-25", time: "18:30", reminder: "За 1 час" },
];

export const initialIdeas: Idea[] = [
  { id: "idea-1", title: "Механическая клавиатура", description: "Тихие свитчи, чтобы печатать с удовольствием.", category: "purchase", status: "thinking", createdAt: "2026-08-10", updatedAt: "2026-08-10" },
  { id: "idea-2", title: "Свой мини-продукт", description: "Собрать прототип за выходные и показать друзьям.", category: "project", status: "plan", createdAt: "2026-08-15", updatedAt: "2026-08-20" },
  { id: "idea-3", title: "Выучить итальянский", category: "someday", status: "new", createdAt: todayIso(), updatedAt: todayIso() },
];
