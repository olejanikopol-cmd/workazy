"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppTab, CalendarEvent, Goal, Idea, JournalEntry, PlanTask } from "@/lib/types";
import { initialEntries, initialEvents, initialGoals, initialIdeas, initialTasks, localDateIso, todayIso } from "@/lib/planner-data";
import { loadPlannerState, savePlannerState } from "@/lib/planner-storage";
import { adoptServerState, defaultApiConfig, loadApiConfig, persistPlannerState, saveApiConfig, type PlannerApiConfig } from "@/lib/planner-api";
import { CalendarScreen, GoalsScreen, IdeasScreen, JournalScreen, ProgressScreen, SettingsSheet } from "./secondary-screens";

const tabs: { id: AppTab; label: string; icon: string }[] = [
  { id: "plan", label: "План", icon: "check" },
  { id: "goals", label: "Цели", icon: "target" },
  { id: "journal", label: "Дневник", icon: "book" },
  { id: "calendar", label: "Календарь", icon: "calendar" },
  { id: "progress", label: "Прогресс", icon: "chart" },
  { id: "ideas", label: "Идеи", icon: "spark" },
];

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "check") return <svg {...common}><path d="M5 12.5 9.2 17 19 7" /></svg>;
  if (name === "target") return <svg {...common}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /><path d="m14.5 9.5 5-5M16 4.5h3.5V8" /></svg>;
  if (name === "book") return <svg {...common}><path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h4v16H7a2.5 2.5 0 0 0-2.5 2V5.5Z" /><path d="M19.5 5.5A2.5 2.5 0 0 0 17 3h-4v16h4a2.5 2.5 0 0 1 2.5 2V5.5Z" /></svg>;
  if (name === "calendar") return <svg {...common}><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>;
  if (name === "chart") return <svg {...common}><path d="M5 20v-6M12 20V8M19 20V4" /></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>;
  if (name === "spark") return <svg {...common}><path d="m12 3 1.3 4.2L17.5 8.5l-4.2 1.3L12 14l-1.3-4.2-4.2-1.3 4.2-1.3L12 3Z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" /></svg>;
  if (name === "more") return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
  if (name === "arrow") return <svg {...common}><path d="m9 5 7 7-7 7" /></svg>;
  if (name === "search") return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>;
  if (name === "download") return <svg {...common}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>;
  if (name === "bell") return <svg {...common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg>;
  if (name === "telegram") return <svg {...common}><path d="m21 4-3 16-6-4-3 3-1-5-5-2 18-8Z" /><path d="m8 14 10-7-8 9" /></svg>;
  if (name === "moon") return <svg {...common}><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" /></svg>;
  return null;
}

export function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function displayDate(iso: string) {
  const today = todayIso();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (iso === today) return "Сегодня";
  if (iso === localDateIso(tomorrow)) return "Завтра";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date(`${iso}T12:00:00`));
}

export default function PlannerApp() {
  const [activeTab, setActiveTab] = useState<AppTab>("plan");
  const [tasks, setTasks] = useState<PlanTask[]>(initialTasks);
  const [goals, setGoals] = useState<Goal[]>(initialGoals);
  const [entries, setEntries] = useState<JournalEntry[]>(initialEntries);
  const [events, setEvents] = useState<CalendarEvent[]>(initialEvents);
  const [ideas, setIdeas] = useState<Idea[]>(initialIdeas);
  const [hydrated, setHydrated] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [editorOpen, setEditorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editorText, setEditorText] = useState("1. ");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<"up" | "down">("down");
  const [apiConfig, setApiConfig] = useState<PlannerApiConfig>(defaultApiConfig);
  const syncArmed = useRef(false);

  const dayTasks = useMemo(() => tasks.filter((task) => task.date === selectedDate), [tasks, selectedDate]);
  const completed = dayTasks.filter((task) => task.completed).length;
  const progress = dayTasks.length ? Math.round((completed / dayTasks.length) * 100) : 0;

  useEffect(() => {
    const saved = loadPlannerState();
    if (saved) {
      if (Array.isArray(saved.tasks)) setTasks(saved.tasks as PlanTask[]);
      if (Array.isArray(saved.goals)) setGoals(saved.goals as Goal[]);
      if (Array.isArray(saved.entries)) setEntries(saved.entries as JournalEntry[]);
      if (Array.isArray(saved.events)) setEvents(saved.events as CalendarEvent[]);
      if (Array.isArray(saved.ideas)) setIdeas(saved.ideas as Idea[]);
    }
    setHydrated(true);

    const config = loadApiConfig();
    if (config.enabled && config.token && config.baseUrl) {
      adoptServerState(config)
        .then((serverState) => {
          if (serverState) {
            setTasks(serverState.tasks);
            setGoals(serverState.goals);
            setEntries(serverState.entries);
            setEvents(serverState.events);
            setIdeas(serverState.ideas);
          }
          setApiConfig(config);
        })
        .catch((error) => {
          console.error("Не удалось включить синхронизацию", error);
          setApiConfig({ ...config, enabled: false });
        });
    } else {
      setApiConfig(config);
    }
  }, []);

  useEffect(() => {
    if (hydrated) savePlannerState({ tasks, goals, entries, events, ideas });
  }, [tasks, goals, entries, events, ideas, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (!syncArmed.current) {
      syncArmed.current = true;
      return;
    }
    if (!apiConfig.enabled || !apiConfig.token || !apiConfig.baseUrl) return;
    const timer = window.setTimeout(() => {
      void persistPlannerState({ tasks, goals, entries, events, ideas }, apiConfig).catch((error) => {
        console.error("Не удалось синхронизировать данные", error);
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [tasks, goals, entries, events, ideas, hydrated, apiConfig]);

  async function updateApiConfig(next: PlannerApiConfig) {
    if (next.enabled) {
      if (!next.baseUrl || !next.token) throw new Error("Укажите адрес сервера и API-токен");
      const previous = apiConfig;
      setApiConfig({ ...previous, enabled: false });
      try {
        const serverState = await adoptServerState(next);
        if (serverState) {
          setTasks(serverState.tasks);
          setGoals(serverState.goals);
          setEntries(serverState.entries);
          setEvents(serverState.events);
          setIdeas(serverState.ideas);
        }
      } catch (error) {
        setApiConfig(previous);
        throw error;
      }
    }
    setApiConfig(next);
    saveApiConfig(next);
  }

  useEffect(() => {
    if (!openMenuId) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (event.target instanceof HTMLElement && event.target.closest(".task-menu")) return;
      setOpenMenuId(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenuId(null);
    }

    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuId]);

  function toggleTask(id: string) {
    setOpenMenuId(null);
    setTasks((current) => current.map((task) => task.id === id ? { ...task, completed: !task.completed } : task));
  }

  function removeTask(id: string) {
    setOpenMenuId(null);
    setTasks((current) => current.filter((task) => task.id !== id));
  }

  function editTask(id: string) {
    const current = tasks.find((task) => task.id === id);
    if (!current) return;
    const next = window.prompt("Изменить пункт", current.title)?.trim();
    if (next) setTasks((items) => items.map((task) => task.id === id ? { ...task, title: next } : task));
    setOpenMenuId(null);
  }

  function moveTask(id: string, direction: -1 | 1) {
    const sameDay = tasks.filter((task) => task.date === selectedDate);
    const index = sameDay.findIndex((task) => task.id === id);
    const target = sameDay[index + direction];
    if (!target) return;
    setTasks((current) => {
      const copy = [...current];
      const from = copy.findIndex((task) => task.id === id);
      const to = copy.findIndex((task) => task.id === target.id);
      [copy[from], copy[to]] = [copy[to], copy[from]];
      return copy;
    });
    setOpenMenuId(null);
  }

  function handleTaskCardClick(event: React.MouseEvent<HTMLElement>, id: string) {
    if (event.target instanceof HTMLElement && event.target.closest("button, input, label, .task-menu")) return;
    toggleTask(id);
  }

  function handleTaskCardKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleTask(id);
  }

  function placeMenu(trigger: Element) {
    const rect = trigger.getBoundingClientRect();
    const bottomNavReserve = 116;
    const menuHeight = 218;
    const spaceBelow = window.innerHeight - rect.bottom - bottomNavReserve;
    const spaceAbove = rect.top;
    setMenuPlacement(spaceBelow < menuHeight && spaceAbove > spaceBelow ? "up" : "down");
  }

  function toggleTaskMenu(id: string, event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (openMenuId === id) {
      setOpenMenuId(null);
      return;
    }

    placeMenu(event.currentTarget);
    setOpenMenuId(id);
  }

  function handleEditorKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const lines = editorText.split("\n");
    setEditorText(`${editorText}\n${lines.length + 1}. `);
  }

  function savePlan() {
    const titles = editorText.split("\n").map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
    if (!titles.length) return;
    const next = titles.map<PlanTask>((title) => ({ id: uid("task"), title, completed: false, date: selectedDate }));
    setTasks((current) => [...current, ...next]);
    setEditorText("1. ");
    setEditorOpen(false);
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-mark" aria-label="Личный планер">Л</div>
          <button className="icon-button" aria-label="Открыть настройки" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={20} /></button>
        </header>

        {activeTab === "plan" && <section className="screen plan-screen" aria-labelledby="plan-title">
          <div className="eyebrow"><span className="status-dot" /> Суббота, 22 августа</div>
          <div className="title-row">
            <div>
              <h1 id="plan-title">{displayDate(selectedDate)}</h1>
              <p className="subtitle">Один ясный день — уже прогресс.</p>
            </div>
            <div className="day-score" aria-label={`${progress} процентов выполнено`}><strong>{progress}</strong><span>%</span></div>
          </div>

          <div className="date-switcher" aria-label="Выбор даты плана">
            <button className={selectedDate === todayIso() ? "active" : ""} onClick={() => setSelectedDate(todayIso())}>Сегодня</button>
            <button className={selectedDate !== todayIso() ? "active" : ""} onClick={() => { const d = new Date(); d.setDate(d.getDate() + 1); setSelectedDate(localDateIso(d)); }}>Завтра</button>
            <label className="date-picker" title="Выбрать дату"><Icon name="calendar" size={18} /><input aria-label="Выбрать другую дату" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} /></label>
          </div>

          <section className="progress-card" aria-label="Прогресс плана">
            <div className="progress-copy"><span>Твой ритм</span><strong>{completed} из {dayTasks.length} выполнено</strong></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          </section>

          <div className="section-heading"><h2>План</h2><span>{dayTasks.length} пунктов</span></div>

          <div className="task-list">
            {dayTasks.map((task, index) => (
              <article key={task.id} className={`task-card ${task.completed ? "completed" : ""} ${openMenuId === task.id ? "menu-open" : ""}`} role="checkbox" aria-checked={task.completed} tabIndex={0} onClick={(event) => handleTaskCardClick(event, task.id)} onKeyDown={(event) => handleTaskCardKeyDown(event, task.id)}>
                <button className="task-check" aria-label={task.completed ? `Вернуть «${task.title}»` : `Выполнить «${task.title}»`} onClick={(event) => { event.stopPropagation(); toggleTask(task.id); }}>{task.completed && <Icon name="check" size={16} />}</button>
                <div className="task-body"><span className="task-index">{String(index + 1).padStart(2, "0")}</span><p>{task.title}</p></div>
                <div className={`task-menu ${openMenuId === task.id ? `open drop-${menuPlacement}` : ""}`}>
                  <button className="task-menu-trigger" type="button" aria-label={`Действия с пунктом «${task.title}»`} aria-expanded={openMenuId === task.id} onClick={(event) => toggleTaskMenu(task.id, event)}><Icon name="more" size={20} /></button>
                  {openMenuId === task.id && <div className="task-menu-popover" role="menu" onClick={(event) => event.stopPropagation()}>
                    <button type="button" onClick={() => editTask(task.id)}>Изменить</button>
                    <button type="button" onClick={() => moveTask(task.id, -1)} disabled={index === 0}>Выше</button>
                    <button type="button" onClick={() => moveTask(task.id, 1)} disabled={index === dayTasks.length - 1}>Ниже</button>
                    <label>Перенести<input type="date" value={task.date} onChange={(e) => { setTasks((items) => items.map((item) => item.id === task.id ? { ...item, date: e.target.value } : item)); setOpenMenuId(null); }} /></label>
                    <button type="button" className="danger" onClick={() => removeTask(task.id)}>Удалить</button>
                  </div>
                  }
                </div>
              </article>
            ))}
            {!dayTasks.length && <div className="empty-card"><Icon name="spark" size={28} /><h3>День пока свободен</h3><p>Добавь план одним быстрым списком.</p></div>}
          </div>

          <button className="primary-action" onClick={() => setEditorOpen(true)}><span><Icon name="plus" size={20} /></span>Составить план</button>
        </section>}

        {activeTab === "goals" && <GoalsScreen goals={goals} setGoals={setGoals} />}
        {activeTab === "journal" && <JournalScreen entries={entries} setEntries={setEntries} />}
        {activeTab === "calendar" && <CalendarScreen tasks={tasks} events={events} setEvents={setEvents} selectedDate={selectedDate} setSelectedDate={setSelectedDate} />}
        {activeTab === "progress" && <ProgressScreen tasks={tasks} goals={goals} entries={entries} />}
        {activeTab === "ideas" && <IdeasScreen ideas={ideas} setIdeas={setIdeas} />}

        <nav className="bottom-nav" aria-label="Основная навигация">
          {tabs.map((tab) => <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}><Icon name={tab.icon} /><span>{tab.label}</span></button>)}
        </nav>
      </div>

      {editorOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditorOpen(false); }}>
        <section className="plan-editor" role="dialog" aria-modal="true" aria-labelledby="editor-title">
          <div className="modal-handle" />
          <div className="editor-head"><div><span>{displayDate(selectedDate)}</span><h2 id="editor-title">Составить план</h2></div><button className="icon-button" onClick={() => setEditorOpen(false)} aria-label="Закрыть"><Icon name="close" size={21} /></button></div>
          <p className="editor-help">Пиши пункты подряд. Enter сам добавит следующий номер.</p>
          <textarea autoFocus value={editorText} onChange={(e) => setEditorText(e.target.value)} onKeyDown={handleEditorKeyDown} aria-label="Пункты плана" spellCheck />
          <div className="editor-footer"><span>{editorText.split("\n").filter((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim()).length} пунктов</span><button onClick={savePlan}>Сохранить план</button></div>
        </section>
      </div>}
      {settingsOpen && <SettingsSheet apiConfig={apiConfig} onSaveApiConfig={updateApiConfig} onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}
