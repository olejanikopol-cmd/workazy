"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, Dispatch, FormEvent, SetStateAction } from "react";
import type { CalendarEvent, Goal, GoalPeriod, Idea, IdeaCategory, IdeaStatus, JournalEntry, PlanTask } from "@/lib/types";
import type { PlannerApiConfig } from "@/lib/planner-api";
import { todayIso } from "@/lib/planner-data";
import { Icon, displayDate, uid } from "./planner-app";

const periodLabels: Record<GoalPeriod, string> = { week: "Неделя", month: "Месяц", year: "Год" };

export function GoalsScreen({ goals, setGoals }: { goals: Goal[]; setGoals: Dispatch<SetStateAction<Goal[]>> }) {
  const [period, setPeriod] = useState<GoalPeriod>("week");
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(todayIso());
  const visible = goals.filter((goal) => goal.period === period);

  function addGoal(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setGoals((current) => [...current, { id: uid("goal"), title: title.trim(), description: description.trim(), period, progress: 0, createdAt: todayIso(), deadline, completed: false }]);
    setTitle("");
    setDescription("");
    setAddOpen(false);
  }

  function removeGoal(goal: Goal) {
    if (!window.confirm(`Удалить цель «${goal.title}»?`)) return;
    setGoals((current) => current.filter((item) => item.id !== goal.id));
  }

  return <section className="screen secondary-screen" aria-labelledby="goals-title">
    <div className="eyebrow"><span className="status-dot" /> Направление</div>
    <div className="secondary-title"><div><h1 id="goals-title">Цели</h1><p>Не список дел. То, куда ты идёшь.</p></div><button className="round-add" onClick={() => setAddOpen(true)} aria-label="Добавить цель"><Icon name="plus" /></button></div>

    <div className="segmented-tabs" role="tablist" aria-label="Период целей">
      {(Object.keys(periodLabels) as GoalPeriod[]).map((value) => <button key={value} role="tab" aria-selected={period === value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{periodLabels[value]}</button>)}
    </div>

    <div className="goal-hero">
      <div><span>Фокус на {periodLabels[period].toLowerCase()}</span><strong>{visible.filter((goal) => goal.completed).length}/{visible.length || 0}</strong></div>
      <p>{period === "week" ? "Маленькие победы, которые двигают всё остальное." : period === "month" ? "Держи перед глазами главное, остальное — фон." : "Год строится из решений, которые ты повторяешь."}</p>
    </div>

    <div className="goal-list">
      {visible.map((goal) => <article className={`goal-card ${goal.completed ? "completed" : ""}`} key={goal.id}>
        <div className="goal-card-head"><span>{periodLabels[goal.period]} · до {new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(`${goal.deadline}T12:00:00`))}</span><div className="goal-card-actions"><button className="goal-delete" onClick={() => removeGoal(goal)} aria-label={`Удалить цель «${goal.title}»`}><Icon name="close" size={16} /></button><button className="goal-complete" onClick={() => setGoals((items) => items.map((item) => item.id === goal.id ? { ...item, completed: !item.completed, progress: item.completed ? item.progress : 100 } : item))} aria-label={goal.completed ? "Вернуть цель в работу" : "Завершить цель"}><Icon name="check" size={16} /></button></div></div>
        <h2>{goal.title}</h2>
        {goal.description && <p>{goal.description}</p>}
        <div className="goal-progress-copy"><span>Прогресс</span><strong>{goal.progress}%</strong></div>
        <input aria-label={`Прогресс цели «${goal.title}»`} type="range" min="0" max="100" step="5" value={goal.progress} onChange={(e) => setGoals((items) => items.map((item) => item.id === goal.id ? { ...item, progress: Number(e.target.value), completed: Number(e.target.value) === 100 } : item))} style={{ "--goal-progress": `${goal.progress}%` } as CSSProperties} />
      </article>)}
      {!visible.length && <div className="empty-card"><Icon name="target" size={30} /><h3>Здесь появится твоя цель</h3><p>Сформулируй один понятный ориентир.</p></div>}
    </div>

    {addOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
      <form className="compact-sheet" onSubmit={addGoal}>
        <div className="modal-handle" /><div className="editor-head"><div><span>{periodLabels[period]}</span><h2>Новая цель</h2></div><button type="button" className="icon-button" onClick={() => setAddOpen(false)}><Icon name="close" /></button></div>
        <label className="field"><span>Название</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, закончить проект" /></label>
        <label className="field"><span>Зачем это тебе</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Необязательно" /></label>
        <label className="field"><span>Срок</span><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label>
        <button className="sheet-submit">Создать цель</button>
      </form>
    </div>}
  </section>;
}

export function JournalScreen({ entries, setEntries }: { entries: JournalEntry[]; setEntries: Dispatch<SetStateAction<JournalEntry[]>> }) {
  const [mode, setMode] = useState<"write" | "history">("write");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mood, setMood] = useState("");
  const [tags, setTags] = useState("");
  const [query, setQuery] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [readingEntry, setReadingEntry] = useState<JournalEntry | null>(null);
  const moods = ["Спокойно", "Энергично", "Тяжело", "Радостно"];
  const filtered = entries.filter((entry) => `${entry.title ?? ""} ${entry.body} ${entry.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));

  function saveEntry() {
    if (!body.trim()) return;
    setEntries((current) => [{ id: uid("entry"), date: todayIso(), title: title.trim(), body: body.trim(), mood, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) }, ...current]);
    setTitle(""); setBody(""); setMood(""); setTags(""); setMode("history");
  }

  function removeEntry(entry: JournalEntry) {
    const label = entry.title?.trim() || displayDate(entry.date);
    if (!window.confirm(`Удалить запись «${label}»?`)) return;
    if (readingEntry?.id === entry.id) setReadingEntry(null);
    setEntries((current) => current.filter((item) => item.id !== entry.id));
  }

  function handleEntryKeyDown(event: React.KeyboardEvent<HTMLElement>, entry: JournalEntry) {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    setReadingEntry(entry);
  }

  return <section className="screen secondary-screen journal-screen" aria-labelledby="journal-title">
    <div className="eyebrow"><span className="status-dot" /> Личное пространство</div>
    <div className="secondary-title"><div><h1 id="journal-title">Дневник</h1><p>Место, где не нужно быть продуктивным.</p></div><button className="icon-button" onClick={() => setExportOpen(true)} aria-label="Экспорт дневника"><Icon name="download" size={19} /></button></div>
    <div className="segmented-tabs journal-tabs"><button className={mode === "write" ? "active" : ""} onClick={() => setMode("write")}>Новая запись</button><button className={mode === "history" ? "active" : ""} onClick={() => setMode("history")}>История <span>{entries.length}</span></button></div>

    {mode === "write" ? <div className="journal-editor">
      <div className="journal-date">{new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</div>
      <input className="journal-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название — необязательно" aria-label="Название записи" />
      <textarea className="journal-body-input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Что сегодня происходило? Что чувствуешь?" aria-label="Текст записи" />
      <div className="mood-row"><span>Настроение</span><div>{moods.map((item) => <button className={mood === item ? "active" : ""} onClick={() => setMood(mood === item ? "" : item)} key={item}>{item}</button>)}</div></div>
      <label className="tag-input"><span>#</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="теги через запятую" /></label>
      <button className="primary-action journal-save" onClick={saveEntry} disabled={!body.trim()}><span><Icon name="check" size={18} /></span>Сохранить запись</button>
    </div> : <div className="journal-history">
      <label className="search-box"><Icon name="search" size={18} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти в записях" /></label>
      <div className="entry-list">{filtered.map((entry) => <article className="entry-card" key={entry.id} role="button" tabIndex={0} onClick={() => setReadingEntry(entry)} onKeyDown={(event) => handleEntryKeyDown(event, entry)}>
        <div className="entry-meta"><span>{displayDate(entry.date)}</span><div className="entry-meta-actions">{entry.mood && <span className="mood-badge">{entry.mood}</span>}<button className="entry-delete" onClick={(event) => { event.stopPropagation(); removeEntry(entry); }} aria-label={`Удалить запись «${entry.title?.trim() || displayDate(entry.date)}»`}><Icon name="close" size={16} /></button></div></div>
        {entry.title && <h2>{entry.title}</h2>}<p>{entry.body}</p>
        {!!entry.tags.length && <div className="entry-tags">{entry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
      </article>)}</div>
    </div>}

    {exportOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setExportOpen(false)}><section className="compact-sheet export-sheet">
      <div className="modal-handle" /><div className="editor-head"><div><span>PDF</span><h2>Экспорт дневника</h2></div><button className="icon-button" onClick={() => setExportOpen(false)}><Icon name="close" /></button></div>
      <p className="sheet-description">Выбери период. Кнопка откроет аккуратную печатную версию, которую можно сохранить как PDF.</p>
      <div className="export-options"><label><input type="radio" name="range" defaultChecked /> Последняя запись</label><label><input type="radio" name="range" /> Эта неделя</label><label><input type="radio" name="range" /> Этот месяц</label><label><input type="radio" name="range" /> Весь дневник</label></div>
      <button className="sheet-submit" onClick={() => window.print()}><Icon name="download" size={18} />Открыть печатную версию</button>
    </section></div>}

    {readingEntry && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setReadingEntry(null)}>
      <section className="compact-sheet entry-reader" role="dialog" aria-modal="true" aria-labelledby="entry-reader-title">
        <div className="modal-handle" />
        <div className="editor-head"><div><span>{displayDate(readingEntry.date)}</span><h2 id="entry-reader-title">{readingEntry.title?.trim() || "Запись дневника"}</h2></div><button className="icon-button" onClick={() => setReadingEntry(null)} aria-label="Закрыть запись"><Icon name="close" /></button></div>
        {readingEntry.mood && <span className="reader-mood">{readingEntry.mood}</span>}
        <div className="entry-reader-body">{readingEntry.body}</div>
        {!!readingEntry.tags.length && <div className="entry-tags reader-tags">{readingEntry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
      </section>
    </div>}
  </section>;
}

function localIso(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function CalendarScreen({ tasks, events, setEvents, selectedDate, setSelectedDate }: { tasks: PlanTask[]; events: CalendarEvent[]; setEvents: Dispatch<SetStateAction<CalendarEvent[]>>; selectedDate: string; setSelectedDate: Dispatch<SetStateAction<string>> }) {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("18:00");
  const [note, setNote] = useState("");
  const [reminder, setReminder] = useState("За 30 минут");
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const start = (new Date(year, month, 1).getDay() + 6) % 7;
  const cells = [...Array(start).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const selectedTasks = tasks.filter((task) => task.date === selectedDate);
  const selectedEvents = events.filter((event) => event.date === selectedDate);

  function addEvent(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setEvents((current) => [...current, { id: uid("event"), title: title.trim(), date: selectedDate, time, note: note.trim(), reminder }]);
    setTitle(""); setNote(""); setAddOpen(false);
  }

  function removeEvent(event: CalendarEvent) {
    if (!window.confirm(`Удалить событие «${event.title}»?`)) return;
    setEvents((current) => current.filter((item) => item.id !== event.id));
  }

  return <section className="screen secondary-screen calendar-screen" aria-labelledby="calendar-title">
    <div className="eyebrow"><span className="status-dot" /> Время и события</div>
    <div className="secondary-title"><div><h1 id="calendar-title">Календарь</h1><p>Всё важное — в контексте дня.</p></div><button className="round-add" onClick={() => setAddOpen(true)} aria-label="Добавить событие"><Icon name="plus" /></button></div>

    <section className="calendar-card">
      <div className="calendar-head"><button aria-label="Предыдущий месяц" onClick={() => setViewDate(new Date(year, month - 1, 1))}><Icon name="arrow" size={18} /></button><h2>{new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(viewDate)}</h2><button aria-label="Следующий месяц" onClick={() => setViewDate(new Date(year, month + 1, 1))}><Icon name="arrow" size={18} /></button></div>
      <div className="weekdays">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="calendar-grid">{cells.map((day, index) => {
        if (!day) return <span className="blank-day" key={`blank-${index}`} />;
        const iso = localIso(year, month, day);
        const hasItems = tasks.some((task) => task.date === iso) || events.some((event) => event.date === iso);
        return <button key={iso} className={`${iso === selectedDate ? "selected" : ""} ${iso === todayIso() ? "today" : ""}`} onClick={() => setSelectedDate(iso)}><span>{day}</span>{hasItems && <i />}</button>;
      })}</div>
    </section>

    <div className="selected-day-head"><div><span>Выбранный день</span><h2>{displayDate(selectedDate)}</h2></div><button onClick={() => setAddOpen(true)}>+ Событие</button></div>
    <div className="day-agenda">
      {selectedEvents.map((event) => <button type="button" className="agenda-item event agenda-event-delete" key={event.id} onClick={() => removeEvent(event)} aria-label={`Удалить событие «${event.title}»`}><div className="agenda-time">{event.time || "—"}</div><div><h3>{event.title}</h3><p>{event.reminder || "Без напоминания"}</p></div><span className="agenda-delete" aria-hidden="true"><Icon name="close" size={15} /></span></button>)}
      {selectedTasks.map((task) => <article className={`agenda-item task ${task.completed ? "done" : ""}`} key={task.id}><div className="agenda-time"><Icon name="check" size={16} /></div><div><h3>{task.title}</h3><p>Пункт плана</p></div><span className="agenda-dot" /></article>)}
      {!selectedEvents.length && !selectedTasks.length && <div className="empty-card mini-empty"><Icon name="calendar" size={24} /><h3>Ничего не запланировано</h3><p>Можно оставить этот день свободным.</p></div>}
    </div>

    {addOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}><form className="compact-sheet" onSubmit={addEvent}>
      <div className="modal-handle" /><div className="editor-head"><div><span>{displayDate(selectedDate)}</span><h2>Новое событие</h2></div><button type="button" className="icon-button" onClick={() => setAddOpen(false)}><Icon name="close" /></button></div>
      <label className="field"><span>Название</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, тренировка" /></label>
      <div className="field-pair"><label className="field"><span>Дата</span><input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} /></label><label className="field"><span>Время</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label></div>
      <label className="field"><span>Заметка</span><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Необязательно" /></label>
      <label className="field"><span>Напоминание</span><select value={reminder} onChange={(e) => setReminder(e.target.value)}><option>За 10 минут</option><option>За 30 минут</option><option>За 1 час</option><option>Не напоминать</option></select></label>
      <button className="sheet-submit">Добавить событие</button>
    </form></div>}
  </section>;
}

export function ProgressScreen({ tasks, goals, entries }: { tasks: PlanTask[]; goals: Goal[]; entries: JournalEntry[] }) {
  const weekTasks = tasks.slice(-20);
  const completed = weekTasks.filter((task) => task.completed).length;
  const percent = weekTasks.length ? Math.round(completed / weekTasks.length * 100) : 0;
  const planDays = new Set(tasks.map((task) => task.date)).size;
  const doneGoals = goals.filter((goal) => goal.completed).length;
  const bars = useMemo(() => [42, 68, 54, 86, 61, 72, Math.max(percent, 12)], [percent]);

  return <section className="screen secondary-screen progress-screen" aria-labelledby="progress-title">
    <div className="eyebrow"><span className="status-dot" /> Без оценок — только факты</div>
    <div className="secondary-title"><div><h1 id="progress-title">Прогресс</h1><p>Посмотри, сколько уже сделано.</p></div><div className="streak"><strong>6</strong><span>дней</span></div></div>
    <section className="week-score"><span>Эта неделя</span><div><strong>{percent}%</strong><p>{completed} выполненных задач</p></div><div className="week-chart" aria-label="Динамика выполнения по дням">{bars.map((height, index) => <span key={index} className={index === bars.length - 1 ? "current" : ""} style={{ height: `${height}%` }}><i>{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][index]}</i></span>)}</div></section>
    <div className="stats-grid">
      <article><Icon name="check" size={20} /><strong>{completed}</strong><span>задач выполнено</span></article>
      <article><Icon name="calendar" size={20} /><strong>{planDays}</strong><span>дней с планом</span></article>
      <article><Icon name="book" size={20} /><strong>{entries.length}</strong><span>записей дневника</span></article>
      <article><Icon name="target" size={20} /><strong>{doneGoals}</strong><span>целей достигнуто</span></article>
    </div>
    <section className="reflection-card"><Icon name="spark" size={22} /><div><span>Наблюдение</span><p>Больше всего задач закрывается в дни, когда план содержит не больше пяти пунктов.</p></div></section>
    <p className="no-ai-note">Статистика считается только по твоим данным — без AI-анализа.</p>
  </section>;
}

const ideaCategoryLabels: Record<IdeaCategory, string> = { thought: "Мысль", want: "Хочуха", project: "Проект", purchase: "Покупка", someday: "Когда-нибудь" };

const ideaStatusLabels: Record<IdeaStatus, string> = { new: "Новая", thinking: "Думаю", plan: "В план", done: "Сделано", archive: "Архив" };

export function IdeasScreen({ ideas, setIdeas }: { ideas: Idea[]; setIdeas: Dispatch<SetStateAction<Idea[]>> }) {
  const [categoryFilter, setCategoryFilter] = useState<IdeaCategory | "all">("all");
  const [statusFilter, setStatusFilter] = useState<IdeaStatus | "all">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<IdeaCategory>("thought");
  const visible = ideas.filter((idea) => (categoryFilter === "all" || idea.category === categoryFilter) && (statusFilter === "all" || idea.status === statusFilter));

  function addIdea(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const now = todayIso();
    setIdeas((current) => [{ id: uid("idea"), title: title.trim(), description: description.trim(), category, status: "new", createdAt: now, updatedAt: now }, ...current]);
    setTitle("");
    setDescription("");
    setAddOpen(false);
  }

  return <section className="screen secondary-screen" aria-labelledby="ideas-title">
    <div className="eyebrow"><span className="status-dot" /> Копилка идей</div>
    <div className="secondary-title"><div><h1 id="ideas-title">Идеи</h1><p>Мысли, хочухи и проекты — всё в одном месте.</p></div><button className="round-add" onClick={() => setAddOpen(true)} aria-label="Добавить идею"><Icon name="plus" /></button></div>

    <div className="mood-row idea-filters"><span>Категория</span><div>
      <button className={categoryFilter === "all" ? "active" : ""} onClick={() => setCategoryFilter("all")}>Все</button>
      {(Object.keys(ideaCategoryLabels) as IdeaCategory[]).map((value) => <button key={value} className={categoryFilter === value ? "active" : ""} onClick={() => setCategoryFilter(categoryFilter === value ? "all" : value)}>{ideaCategoryLabels[value]}</button>)}
    </div></div>

    <div className="mood-row idea-filters"><span>Статус</span><div>
      <button className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>Все</button>
      {(Object.keys(ideaStatusLabels) as IdeaStatus[]).map((value) => <button key={value} className={statusFilter === value ? "active" : ""} onClick={() => setStatusFilter(statusFilter === value ? "all" : value)}>{ideaStatusLabels[value]}</button>)}
    </div></div>

    <div className="idea-list">
      {visible.map((idea) => <article className="idea-card" key={idea.id}>
        <div className="idea-card-head"><span>{ideaCategoryLabels[idea.category]}</span><button onClick={() => setIdeas((items) => items.filter((item) => item.id !== idea.id))} aria-label={`Удалить идею «${idea.title}»`}><Icon name="close" size={16} /></button></div>
        <h2>{idea.title}</h2>
        {idea.description && <p>{idea.description}</p>}
        <select className="idea-status" aria-label={`Статус идеи «${idea.title}»`} value={idea.status} onChange={(e) => setIdeas((items) => items.map((item) => item.id === idea.id ? { ...item, status: e.target.value as IdeaStatus, updatedAt: todayIso() } : item))}>
          {(Object.keys(ideaStatusLabels) as IdeaStatus[]).map((value) => <option key={value} value={value}>{ideaStatusLabels[value]}</option>)}
        </select>
      </article>)}
      {!visible.length && <div className="empty-card"><Icon name="spark" size={30} /><h3>Пока пусто</h3><p>Запиши первую идею — она не потеряется.</p></div>}
    </div>

    {addOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
      <form className="compact-sheet" onSubmit={addIdea}>
        <div className="modal-handle" /><div className="editor-head"><div><span>Копилка</span><h2>Новая идея</h2></div><button type="button" className="icon-button" onClick={() => setAddOpen(false)}><Icon name="close" /></button></div>
        <label className="field"><span>Что за идея</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, хочу механическую клавиатуру" /></label>
        <label className="field"><span>Описание</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Необязательно" /></label>
        <label className="field"><span>Категория</span><select value={category} onChange={(e) => setCategory(e.target.value as IdeaCategory)}>{(Object.keys(ideaCategoryLabels) as IdeaCategory[]).map((value) => <option key={value} value={value}>{ideaCategoryLabels[value]}</option>)}</select></label>
        <button className="sheet-submit">Записать идею</button>
      </form>
    </div>}
  </section>;
}

export function SettingsSheet({ apiConfig, onSaveApiConfig, onClose }: {
  apiConfig: PlannerApiConfig;
  onSaveApiConfig: (config: PlannerApiConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [pushEnabled, setPushEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState(apiConfig.baseUrl);
  const [token, setToken] = useState(apiConfig.token);
  const [syncEnabled, setSyncEnabled] = useState(apiConfig.enabled);
  const [syncStatus, setSyncStatus] = useState("");
  const [syncSaving, setSyncSaving] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<{
    configured: boolean;
    lastSentAt: string | null;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const refreshTelegramStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const response = await fetch("/api/telegram/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Status unavailable");
      setTelegramStatus(await response.json());
    } catch {
      setTelegramStatus({ configured: false, lastSentAt: null });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTelegramStatus();
  }, [refreshTelegramStatus]);

  const telegramCopy = statusLoading
    ? "Проверяем подключение…"
    : telegramStatus?.configured
      ? telegramStatus.lastSentAt
        ? `Работает · последнее ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(telegramStatus.lastSentAt))}`
        : "Подключено · каждый час"
      : "Требуется настройка бота";

  async function saveServerConfig() {
    setSyncSaving(true);
    setSyncStatus(syncEnabled ? "Проверка..." : "Сохранение...");
    try {
      await onSaveApiConfig({ baseUrl: baseUrl.trim(), token: token.trim(), enabled: syncEnabled });
      setSyncStatus(syncEnabled ? "Подключено" : "Сохранено");
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : "Не удалось подключиться");
    } finally {
      setSyncSaving(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="compact-sheet settings-sheet">
    <div className="modal-handle" /><div className="editor-head"><div><span>Подключения</span><h2>Напоминания</h2></div><button className="icon-button" onClick={onClose} aria-label="Закрыть"><Icon name="close" /></button></div>
    <p className="sheet-description">Telegram напоминает о следующем шаге каждый час — даже когда планер закрыт.</p>
    <div className="settings-list">
      <article><div className="setting-icon telegram"><Icon name="telegram" /></div><div><h3>Telegram</h3><p>{telegramCopy}</p></div><button onClick={() => void refreshTelegramStatus()} disabled={statusLoading}>{statusLoading ? "…" : "Обновить"}</button></article>
      <article><div className="setting-icon"><Icon name="bell" /></div><div><h3>Browser Push</h3><p>{pushEnabled ? "Включены" : "Выключены"}</p></div><label className="toggle"><input type="checkbox" checked={pushEnabled} onChange={(e) => setPushEnabled(e.target.checked)} /><span /></label></article>
      <article className="muted-setting"><div className="setting-icon">SMS</div><div><h3>SMS</h3><p>Будет доступно позже</p></div><span className="soon">Скоро</span></article>
    </div>
    <div className="editor-head sync-head"><div><span>Сервер</span><h2>Синхронизация</h2></div></div>
    <div className="sync-fields">
      <label className="field"><span>Адрес сервера</span><input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSyncStatus(""); }} placeholder="https://workazy.example.com" autoComplete="off" /></label>
      <label className="field"><span>API-токен</span><input value={token} onChange={(e) => { setToken(e.target.value); setSyncStatus(""); }} placeholder="Bearer-токен Workazy" type="password" autoComplete="off" /></label>
      <div className="sync-row">
        <div><h3>Включить синхронизацию</h3><p>Данные сохраняются локально и копируются на сервер</p></div>
        <label className="toggle"><input type="checkbox" checked={syncEnabled} onChange={(e) => { setSyncEnabled(e.target.checked); setSyncStatus(""); }} /><span /></label>
      </div>
      <div className="sync-actions">
        <button onClick={saveServerConfig} disabled={syncSaving}>{syncSaving ? "Проверка" : "Сохранить"}</button>
        {syncStatus && <span>{syncStatus}</span>}
      </div>
    </div>
    <div className="integration-note"><Icon name="spark" size={18} /><p>Каждый час приходит сводка по плану. Повторный запуск в тот же час не создаёт дубль.</p></div>
  </section></div>;
}
