"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, Dispatch, FormEvent, ReactNode, SetStateAction } from "react";
import type { Assignment, CalendarEvent, Goal, GoalPeriod, Idea, IdeaCategory, IdeaStatus, JournalEntry, JournalMedia, PlanTask } from "@/lib/types";
import type { PlannerApiConfig } from "@/lib/planner-api";
import { createAssignmentRemote, createJournalEntryRemote, defaultApiConfig, deleteAssignmentRemote, deleteJournalEntryRemote, deleteMediaRemote, fetchMediaBytes, fetchMediaPlaybackUrl, requestTranscription, updateAssignmentRemote, updateJournalEntryRemote, uploadJournalMediaFile, validateMediaUploadSizes } from "@/lib/planner-api";
import { localDateIso, todayIso } from "@/lib/planner-data";
import { recorderIsSupported } from "@/lib/media-recorder";
import { createJournalBackupZip, downloadBlob, entryToMarkdown, mediaFileName, type BackupProgress } from "@/lib/journal-export";
import { EntryMediaBadges, EntryMediaBlock, MediaDraftCard, MediaRecorderPanel, draftFileName, entrySearchText, type MediaDraft, type RecordingDoneResult } from "./journal-media";
import { Icon, displayDate, uid } from "./planner-app";

const periodLabels: Record<GoalPeriod, string> = { week: "Неделя", month: "Месяц", year: "Год" };

export function TaskTextSheet({ task, onClose, onToggle }: {
  task: PlanTask;
  onClose: () => void;
  onToggle: (id: string) => void;
}) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="compact-sheet task-reader" role="dialog" aria-modal="true" aria-labelledby="task-reader-title">
      <div className="modal-handle" />
      <div className="editor-head">
        <div><span>{displayDate(task.date)}</span><h2 id="task-reader-title">Пункт плана</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={21} /></button>
      </div>
      <div className="task-reader-status">
        <span className={task.completed ? "done" : "pending"}>{task.completed ? "Выполнено" : "Не выполнено"}</span>
      </div>
      <p className="task-reader-body">{task.title}</p>
      <button className="sheet-submit" type="button" onClick={() => onToggle(task.id)}>{task.completed ? "Вернуть в работу" : "Отметить выполненным"}</button>
    </section>
  </div>;
}

type TaskFilter = "active" | "all" | "done";

const taskFilterLabels: Record<TaskFilter, string> = { active: "Активные", all: "Все", done: "Готовые" };

function AssignmentTextSheet({ assignment, onClose, onToggle, onDelete }: {
  assignment: Assignment;
  onClose: () => void;
  onToggle: (id: string) => void;
  onDelete: (assignment: Assignment) => void;
}) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="compact-sheet task-reader" role="dialog" aria-modal="true" aria-labelledby="assignment-reader-title">
      <div className="modal-handle" />
      <div className="editor-head">
        <div><span>{assignment.dueDate ? `Срок · ${displayDate(assignment.dueDate)}` : "Без срока"}</span><h2 id="assignment-reader-title">Задание</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть"><Icon name="close" size={21} /></button>
      </div>
      <div className="task-reader-status"><span className={assignment.completed ? "done" : "pending"}>{assignment.completed ? "Выполнено" : "В работе"}</span></div>
      <h3 className="assignment-reader-title">{assignment.title}</h3>
      {assignment.description && <p className="task-reader-body">{assignment.description}</p>}
      <button className="sheet-submit" type="button" onClick={() => onToggle(assignment.id)}>{assignment.completed ? "Вернуть в работу" : "Отметить выполненным"}</button>
      <button className="sheet-danger" type="button" onClick={() => onDelete(assignment)}>Удалить задание</button>
    </section>
  </div>;
}

export function TasksScreen({ assignments, setAssignments, apiConfig, sectionTabs }: { assignments: Assignment[]; setAssignments: Dispatch<SetStateAction<Assignment[]>>; apiConfig: PlannerApiConfig; sectionTabs?: ReactNode }) {
  const [filter, setFilter] = useState<TaskFilter>("active");
  const [title, setTitle] = useState("");
  const [readingAssignmentId, setReadingAssignmentId] = useState<string | null>(null);
  const readingAssignment = readingAssignmentId ? assignments.find((assignment) => assignment.id === readingAssignmentId) ?? null : null;
  const visible = [...assignments]
    .filter((assignment) => filter === "all" || (filter === "done" ? assignment.completed : !assignment.completed))
    .sort((a, b) => filter === "active" ? (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") : b.updatedAt.localeCompare(a.updatedAt));
  const activeCount = assignments.filter((assignment) => !assignment.completed).length;
  const syncEnabled = apiConfig.enabled;

  async function addAssignment(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    const optimistic: Assignment = { id: uid("assignment"), title: trimmed, completed: false, createdAt: now, updatedAt: now };
    setAssignments((current) => [optimistic, ...current]);
    setTitle("");
    if (!syncEnabled) return;
    try {
      const saved = await createAssignmentRemote(apiConfig, { title: trimmed });
      setAssignments((current) => current.map((item) => item.id === optimistic.id ? saved : item));
    } catch (error) {
      setAssignments((current) => current.filter((item) => item.id !== optimistic.id));
      window.alert(error instanceof Error ? error.message : "Не удалось сохранить задание");
    }
  }

  async function toggleAssignment(id: string) {
    const currentAssignment = assignments.find((assignment) => assignment.id === id);
    if (!currentAssignment) return;
    const now = new Date().toISOString();
    const completed = !currentAssignment.completed;
    setAssignments((current) => current.map((assignment) => assignment.id === id ? { ...assignment, completed, updatedAt: now } : assignment));
    if (!syncEnabled) return;
    try {
      const saved = await updateAssignmentRemote(apiConfig, id, { completed });
      setAssignments((current) => current.map((assignment) => assignment.id === id ? saved : assignment));
    } catch (error) {
      setAssignments((current) => current.map((assignment) => assignment.id === id ? currentAssignment : assignment));
      window.alert(error instanceof Error ? error.message : "Не удалось обновить задание");
    }
  }

  async function deleteAssignment(assignment: Assignment) {
    if (!window.confirm(`Удалить задание «${assignment.title}»?`)) return;
    setAssignments((current) => current.filter((item) => item.id !== assignment.id));
    setReadingAssignmentId(null);
    if (!syncEnabled) return;
    try {
      await deleteAssignmentRemote(apiConfig, assignment.id);
    } catch (error) {
      setAssignments((current) => [assignment, ...current]);
      window.alert(error instanceof Error ? error.message : "Не удалось удалить задание");
    }
  }

  return <section className="screen secondary-screen assignments-screen" aria-labelledby="assignments-title">
    <div className="eyebrow"><span className="status-dot" /> Отдельно от ежедневного плана</div>
    <div className="secondary-title">
      <div><h1 id="assignments-title">Задания</h1><p>Из Workazy GPT и добавленные тобой.</p></div>
      <div className="streak"><strong>{activeCount}</strong><span>активно</span></div>
    </div>
    {sectionTabs}

    <form className="quick-task-form assignment-quick-form" onSubmit={(event) => void addAssignment(event)}>
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Добавить новое задание" aria-label="Название нового задания" />
      <button type="submit" disabled={!title.trim()} aria-label="Добавить задание"><Icon name="plus" size={18} /></button>
    </form>

    <div className="segmented-tabs assignment-tabs" role="tablist" aria-label="Фильтр заданий">
      {(Object.keys(taskFilterLabels) as TaskFilter[]).map((value) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{taskFilterLabels[value]}</button>)}
    </div>

    <div className="assignment-list">
      {visible.map((assignment) => <article className={`assignment-card ${assignment.completed ? "completed" : ""}`} key={assignment.id}>
        <button className="assignment-check" type="button" aria-label={assignment.completed ? `Вернуть «${assignment.title}»` : `Выполнить «${assignment.title}»`} onClick={() => void toggleAssignment(assignment.id)}>{assignment.completed && <Icon name="check" size={16} />}</button>
        <button className="assignment-open" type="button" onClick={() => setReadingAssignmentId(assignment.id)} aria-haspopup="dialog">
          <span>{assignment.dueDate ? `До ${displayDate(assignment.dueDate).toLowerCase()}` : "Без срока"}</span>
          <strong>{assignment.title}</strong>
          {assignment.description && <p>{assignment.description}</p>}
        </button>
        <Icon name="arrow" size={16} />
      </article>)}
      {!visible.length && <div className="empty-card"><Icon name="check" size={30} /><h3>{filter === "active" ? "Активных заданий нет" : "Здесь пока пусто"}</h3><p>Задания из Workazy GPT и добавленные вручную появятся здесь.</p></div>}
    </div>

    {readingAssignment && <AssignmentTextSheet assignment={readingAssignment} onClose={() => setReadingAssignmentId(null)} onToggle={(id) => void toggleAssignment(id)} onDelete={(assignment) => void deleteAssignment(assignment)} />}
  </section>;
}

export function GoalsScreen({ goals, setGoals, sectionTabs }: { goals: Goal[]; setGoals: Dispatch<SetStateAction<Goal[]>>; sectionTabs?: ReactNode }) {
  const [period, setPeriod] = useState<GoalPeriod>("week");
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(todayIso());
  const visible = goals.filter((goal) => goal.period === period);

  function addGoal(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const now = todayIso();
    setGoals((current) => [...current, { id: uid("goal"), title: title.trim(), description: description.trim(), period, progress: 0, createdAt: now, deadline, completed: false, updatedAt: now }]);
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
    {sectionTabs}

    <div className="segmented-tabs" role="tablist" aria-label="Период целей">
      {(Object.keys(periodLabels) as GoalPeriod[]).map((value) => <button key={value} role="tab" aria-selected={period === value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{periodLabels[value]}</button>)}
    </div>

    <div className="goal-hero">
      <div><span>Фокус на {periodLabels[period].toLowerCase()}</span><strong>{visible.filter((goal) => goal.completed).length}/{visible.length || 0}</strong></div>
      <p>{period === "week" ? "Маленькие победы, которые двигают всё остальное." : period === "month" ? "Держи перед глазами главное, остальное — фон." : "Год строится из решений, которые ты повторяешь."}</p>
    </div>

    <div className="goal-list">
      {visible.map((goal) => <article className={`goal-card ${goal.completed ? "completed" : ""}`} key={goal.id}>
        <div className="goal-card-head"><span>{periodLabels[goal.period]} · до {new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(`${goal.deadline}T12:00:00`))}</span><div className="goal-card-actions"><button className="goal-delete" onClick={() => removeGoal(goal)} aria-label={`Удалить цель «${goal.title}»`}><Icon name="close" size={16} /></button><button className="goal-complete" onClick={() => setGoals((items) => items.map((item) => item.id === goal.id ? { ...item, completed: !item.completed, progress: item.completed ? item.progress : 100, updatedAt: todayIso() } : item))} aria-label={goal.completed ? "Вернуть цель в работу" : "Завершить цель"}><Icon name="check" size={16} /></button></div></div>
        <h2>{goal.title}</h2>
        {goal.description && <p>{goal.description}</p>}
        <div className="goal-progress-copy"><span>Прогресс</span><strong>{goal.progress}%</strong></div>
        <input aria-label={`Прогресс цели «${goal.title}»`} type="range" min="0" max="100" step="5" value={goal.progress} onChange={(e) => setGoals((items) => items.map((item) => item.id === goal.id ? { ...item, progress: Number(e.target.value), completed: Number(e.target.value) === 100, updatedAt: todayIso() } : item))} style={{ "--goal-progress": `${goal.progress}%` } as CSSProperties} />
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

export function JournalScreen({ entries, setEntries, apiConfig, sectionTabs }: { entries: JournalEntry[]; setEntries: Dispatch<SetStateAction<JournalEntry[]>>; apiConfig: PlannerApiConfig; sectionTabs?: ReactNode }) {
  const [mode, setMode] = useState<"write" | "history">("write");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mood, setMood] = useState("");
  const [tags, setTags] = useState("");
  const [query, setQuery] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [readingEntry, setReadingEntry] = useState<JournalEntry | null>(null);
  const [recorderKind, setRecorderKind] = useState<"audio" | "video" | null>(null);
  const [drafts, setDrafts] = useState<MediaDraft[]>([]);
  const [draftEntryId, setDraftEntryId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const draftEntryIdRef = useRef<string | null>(null);
  const draftsRef = useRef<MediaDraft[]>([]);
  const uploadControllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  const syncEnabled = apiConfig.enabled;
  const moods = ["Спокойно", "Энергично", "Тяжело", "Радостно"];
  const filtered = entries.filter((entry) => entrySearchText(entry).toLowerCase().includes(query.toLowerCase()));

  function setDraftEntryIdBoth(id: string | null) {
    draftEntryIdRef.current = id;
    setDraftEntryId(id);
  }

  function updateDraft(key: string, changes: Partial<MediaDraft>) {
    setDrafts((current) => current.map((item) => (item.key === key ? { ...item, ...changes } : item)));
  }

  // Запись-якорь сразу попадает в локальное состояние: иначе любая
  // синхронизация (PUT /state) посчитала бы её удалённой и вычистила бы
  // вместе с уже загруженными файлами.
  function upsertAnchorEntry(entryId: string, media?: JournalMedia[]) {
    setEntries((current) => {
      if (!current.some((item) => item.id === entryId)) {
        return [{ id: entryId, date: todayIso(), title: "", body: "", tags: [], media: media ?? [] }, ...current];
      }
      if (!media) return current;
      return current.map((item) => (item.id === entryId ? { ...item, media } : item));
    });
  }

  // Актуальный список метаданных для якоря: серверные данные черновиков
  // плюс свежий элемент (состояние черновиков может ещё не успеть в эффект).
  function anchorMediaList(updated: JournalMedia): JournalMedia[] {
    const existing = draftsRef.current
      .filter((draft) => draft.server && draft.server.id !== updated.id)
      .map((draft) => draft.server as JournalMedia);
    return [...existing, updated];
  }

  // Черновик появляется сразу после остановки записи. При включённой
  // синхронизации файл уходит на сервер, затем запускается расшифровка.
  // Ошибка расшифровки не трогает файл — повтор работает по сохранённому.
  async function uploadDraft(key: string) {
    const draft = draftsRef.current.find((item) => item.key === key);
    if (!draft || draft.mediaId || !syncEnabled) return;

    try {
      validateMediaUploadSizes({
        journalEntryId: draftEntryIdRef.current ?? "pending",
        type: draft.type,
        file: draft.blob,
        fileName: draftFileName(draft),
        audioTrack: draft.audioTrack,
      });
    } catch (error) {
      updateDraft(key, { status: { phase: "error", message: error instanceof Error ? error.message : "Файл слишком большой" } });
      return;
    }

    let entryId = draftEntryIdRef.current;
    try {
      if (!entryId) {
        entryId = uid("entry");
        await createJournalEntryRemote(apiConfig, { id: entryId, date: todayIso(), body: "" });
        setDraftEntryIdBoth(entryId);
        upsertAnchorEntry(entryId);
      }
    } catch (error) {
      updateDraft(key, { status: { phase: "error", message: error instanceof Error ? error.message : "Не удалось создать запись на сервере" } });
      return;
    }

    updateDraft(key, { status: { phase: "uploading", percent: 0 } });
    const controller = new AbortController();
    uploadControllersRef.current.set(key, controller);
    try {
      const media = await uploadJournalMediaFile(apiConfig, {
        journalEntryId: entryId,
        type: draft.type,
        file: draft.blob,
        fileName: draftFileName(draft),
        audioTrack: draft.audioTrack,
        audioTrackFileName: draft.audioTrack ? `track-${draft.key.slice(-5)}.webm` : undefined,
        durationMs: draft.durationMs,
        width: draft.width,
        height: draft.height,
        onProgress: (percent) => updateDraft(key, { status: { phase: "uploading", percent } }),
        signal: controller.signal,
      });
      if (!draftsRef.current.some((item) => item.key === key)) {
        await deleteMediaRemote(apiConfig, media.id);
        return;
      }
      updateDraft(key, { mediaId: media.id, server: media, status: { phase: "transcribing" } });
      upsertAnchorEntry(entryId, anchorMediaList(media));
      const transcribed = await requestTranscription(apiConfig, media.id);
      updateDraft(key, {
        server: transcribed,
        status: transcribed.transcriptionStatus === "ready"
          ? { phase: "ready" }
          : { phase: "error", message: transcribed.transcriptionError ?? "Не удалось расшифровать речь" },
      });
      upsertAnchorEntry(entryId, anchorMediaList(transcribed));
    } catch (error) {
      updateDraft(key, { status: { phase: "error", message: error instanceof Error ? error.message : "Не удалось загрузить файл" } });
    } finally {
      uploadControllersRef.current.delete(key);
    }
  }

  // Повтор: если файла ещё нет на сервере — вся загрузка, иначе только расшифровка.
  async function retryDraft(draft: MediaDraft) {
    setDraftError(null);
    if (!draft.mediaId) {
      await uploadDraft(draft.key);
      return;
    }
    updateDraft(draft.key, { status: { phase: "transcribing" } });
    try {
      const transcribed = await requestTranscription(apiConfig, draft.mediaId);
      updateDraft(draft.key, {
        server: transcribed,
        status: transcribed.transcriptionStatus === "ready"
          ? { phase: "ready" }
          : { phase: "error", message: transcribed.transcriptionError ?? "Не удалось расшифровать речь" },
      });
      const entryId = draftEntryIdRef.current;
      if (entryId) upsertAnchorEntry(entryId, anchorMediaList(transcribed));
    } catch (error) {
      updateDraft(draft.key, { status: { phase: "error", message: error instanceof Error ? error.message : "Не удалось повторить расшифровку" } });
    }
  }

  // Синхронизацию включили позже — догоняем локальные черновики.
  useEffect(() => {
    if (!syncEnabled) return;
    draftsRef.current
      .filter((item) => item.status.phase === "local")
      .forEach((item) => void uploadDraft(item.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncEnabled]);

  async function removeDraft(draft: MediaDraft) {
    uploadControllersRef.current.get(draft.key)?.abort();
    if (draft.mediaId) {
      try {
        await deleteMediaRemote(apiConfig, draft.mediaId);
      } catch (error) {
        setDraftError(error instanceof Error ? error.message : "Не удалось удалить файл с сервера");
        return;
      }
    }
    URL.revokeObjectURL(draft.previewUrl);
    const remaining = draftsRef.current.filter((item) => item.key !== draft.key);
    setDrafts(remaining);
    draftsRef.current = remaining;
    const entryId = draftEntryIdRef.current;
    if (draft.mediaId) {
      // Убираем файл из записи-якоря в локальном состоянии.
      if (entryId) {
        const media = remaining.filter((item) => item.server).map((item) => item.server as JournalMedia);
        upsertAnchorEntry(entryId, media);
      }
    }
    // Пустая серверная запись-заготовка без файлов и текста больше не нужна.
    if (entryId && remaining.length === 0 && !body.trim()) {
      setDraftEntryIdBoth(null);
      setEntries((current) => current.filter((item) => item.id !== entryId));
      await deleteJournalEntryRemote(apiConfig, entryId).catch(() => undefined);
    }
  }

  function startRecorder(kind: "audio" | "video") {
    if (recorderKind) return;
    if (!recorderIsSupported()) {
      setDraftError("Браузер не поддерживает запись аудио и видео.");
      return;
    }
    setDraftError(null);
    setRecorderKind(kind);
  }

  function handleRecordingDone(result: RecordingDoneResult) {
    const kind = recorderKind ?? "audio";
    setRecorderKind(null);
    const key = uid("media-draft");
    const draft: MediaDraft = {
      key,
      type: kind,
      blob: result.blob,
      audioTrack: kind === "video" ? result.audioTrack : null,
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      width: result.width,
      height: result.height,
      previewUrl: URL.createObjectURL(result.blob),
      status: { phase: "local" },
    };
    setDrafts((current) => [...current, draft]);
    draftsRef.current = [...draftsRef.current, draft];
    if (syncEnabled) void uploadDraft(key);
  }

  async function saveEntry() {
    setDraftError(null);
    const hasText = body.trim().length > 0;
    if (!hasText && !drafts.length) return;
    if (drafts.some((draft) => draft.status.phase === "uploading")) {
      setDraftError("Подожди, пока файлы загрузятся на сервер.");
      return;
    }
    if (drafts.some((draft) => !draft.mediaId)) {
      setDraftError("Не все записи попали на сервер. Дождись подключения Workazy Cloud и повтори загрузку или убери черновики.");
      return;
    }

    const parsedTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    const media = drafts.map((draft) => draft.server).filter((item): item is JournalMedia => Boolean(item));
    const entryId = draftEntryId ?? uid("entry");
    setSaving(true);

    try {
      if (draftEntryId) {
        // Серверная запись уже создана под файлы — дозаполняем её текстом.
        try {
          await updateJournalEntryRemote(apiConfig, draftEntryId, {
            title: title.trim() || null,
            body: body.trim() || null,
            mood: mood || null,
            tags: parsedTags,
          });
        } catch {
          // Текст доберётся следующей синхронизацией; запись и медиа уже на сервере.
        }
      }
      setEntries((current) => {
        const rest = current.filter((item) => item.id !== entryId);
        return [{ id: entryId, date: todayIso(), title: title.trim(), body: body.trim(), mood, tags: parsedTags, media }, ...rest];
      });
      drafts.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
      setTitle(""); setBody(""); setMood(""); setTags("");
      setDrafts([]); setDraftEntryIdBoth(null);
      setMode("history");
    } finally {
      setSaving(false);
    }
  }

  function updateEntryMedia(entryId: string, media: JournalMedia[]) {
    setEntries((current) => current.map((item) => (item.id === entryId ? { ...item, media } : item)));
    setReadingEntry((current) => (current && current.id === entryId ? { ...current, media } : current));
  }

  function exportEntry(entry: JournalEntry, format: "md" | "txt" | "json") {
    const baseName = `journal-${entry.date}-${entry.id.slice(-5)}`;
    if (format === "md") {
      downloadBlob(entryToMarkdown(entry), `${baseName}.md`, "text/markdown;charset=utf-8");
      return;
    }
    if (format === "txt") {
      const lines = [`${entry.title?.trim() || "Запись дневника"} — ${entry.date}`, ""];
      if ((entry.body ?? "").trim()) lines.push((entry.body ?? "").trim(), "");
      for (const item of entry.media ?? []) {
        lines.push(`${item.type === "video" ? "Видео" : "Аудио"}:`, item.transcript ?? "(транскрипт недоступен)", "");
      }
      downloadBlob(lines.join("\n"), `${baseName}.txt`, "text/plain;charset=utf-8");
      return;
    }
    downloadBlob(JSON.stringify(entry, null, 2), `${baseName}.json`, "application/json;charset=utf-8");
  }

  async function downloadEntryMedia(entry: JournalEntry) {
    try {
      for (const item of entry.media ?? []) {
        const url = await fetchMediaPlaybackUrl(apiConfig, item.id);
        const bytes = await fetchMediaBytes(url);
        downloadBlob(bytes, mediaFileName(item), item.mimeType);
      }
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Не удалось скачать медиафайл");
    }
  }

  async function runFullBackup() {
    if (!syncEnabled) {
      setBackupError("Полный бэкап станет доступен после подключения Workazy Cloud: медиафайлы живут на сервере.");
      return;
    }
    setBackupBusy(true);
    setBackupError(null);
    setBackupProgress(null);
    try {
      const zip = await createJournalBackupZip(entries, async (item) => {
        const url = await fetchMediaPlaybackUrl(apiConfig, item.id);
        return fetchMediaBytes(url);
      }, setBackupProgress);
      downloadBlob(zip, `workazy-journal-backup-${todayIso()}.zip`, "application/zip");
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "Не удалось собрать бэкап");
    } finally {
      setBackupBusy(false);
    }
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
    {sectionTabs}
    <div className="segmented-tabs journal-tabs"><button className={mode === "write" ? "active" : ""} onClick={() => setMode("write")}>Новая запись</button><button className={mode === "history" ? "active" : ""} onClick={() => setMode("history")}>История <span>{entries.length}</span></button></div>

    {mode === "write" ? <div className="journal-editor">
      <div className="journal-date">{new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</div>
      <input className="journal-title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название — необязательно" aria-label="Название записи" />
      <textarea className="journal-body-input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Что сегодня происходило? Что чувствуешь?" aria-label="Текст записи" />
      <div className="journal-media-actions">
        <button className="ghost-action" onClick={() => startRecorder("audio")} disabled={recorderKind !== null}><Icon name="mic" size={16} />Голосовая запись</button>
        <button className="ghost-action" onClick={() => startRecorder("video")} disabled={recorderKind !== null}><Icon name="video" size={16} />Видео</button>
      </div>
      {!syncEnabled && <p className="media-hint">Workazy Cloud переподключается. После подключения голос или видео загрузятся автоматически.</p>}
      {draftError && <p className="media-error" role="alert">{draftError}</p>}
      {recorderKind && <MediaRecorderPanel kind={recorderKind} onDone={handleRecordingDone} onCancel={() => setRecorderKind(null)} />}
      {!!drafts.length && <div className="draft-list">{drafts.map((draft) => <MediaDraftCard key={draft.key} draft={draft} onRemove={() => void removeDraft(draft)} onRetry={() => void retryDraft(draft)} />)}</div>}
      <div className="mood-row"><span>Настроение</span><div>{moods.map((item) => <button className={mood === item ? "active" : ""} onClick={() => setMood(mood === item ? "" : item)} key={item}>{item}</button>)}</div></div>
      <label className="tag-input"><span>#</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="теги через запятую" /></label>
      <button className="primary-action journal-save" onClick={() => void saveEntry()} disabled={saving || (!body.trim() && !drafts.length)}><span><Icon name="check" size={18} /></span>Сохранить запись</button>
    </div> : <div className="journal-history">
      <label className="search-box"><Icon name="search" size={18} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти в записях" /></label>
      <div className="entry-list">{filtered.map((entry) => <article className="entry-card" key={entry.id} role="button" tabIndex={0} onClick={() => setReadingEntry(entry)} onKeyDown={(event) => handleEntryKeyDown(event, entry)}>
        <div className="entry-meta"><span>{displayDate(entry.date)}</span><div className="entry-meta-actions"><EntryMediaBadges entry={entry} />{entry.mood && <span className="mood-badge">{entry.mood}</span>}<button className="entry-delete" onClick={(event) => { event.stopPropagation(); removeEntry(entry); }} aria-label={`Удалить запись «${entry.title?.trim() || displayDate(entry.date)}»`}><Icon name="close" size={16} /></button></div></div>
        {entry.title && <h2>{entry.title}</h2>}
        <p>{(entry.body ?? "").trim() || (entry.media ?? [])[0]?.transcript || ((entry.media ?? []).length ? ((entry.media ?? [])[0].type === "video" ? "Видеозапись без текста" : "Голосовая запись без текста") : "")}</p>
        {!!entry.tags.length && <div className="entry-tags">{entry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
      </article>)}</div>
    </div>}

    {exportOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setExportOpen(false)}><section className="compact-sheet export-sheet">
      <div className="modal-handle" /><div className="editor-head"><div><span>PDF</span><h2>Экспорт дневника</h2></div><button className="icon-button" onClick={() => setExportOpen(false)}><Icon name="close" /></button></div>
      <p className="sheet-description">Выбери период. Кнопка откроет аккуратную печатную версию, которую можно сохранить как PDF.</p>
      <div className="export-options"><label><input type="radio" name="range" defaultChecked /> Последняя запись</label><label><input type="radio" name="range" /> Эта неделя</label><label><input type="radio" name="range" /> Этот месяц</label><label><input type="radio" name="range" /> Весь дневник</label></div>
      <button className="sheet-submit" onClick={() => window.print()}><Icon name="download" size={18} />Открыть печатную версию</button>
      <div className="export-backup">
        <h3>Полный бэкап</h3>
        <p className="sheet-description">ZIP-архив со всеми записями: текст, транскрипты и оригиналы аудио/видео. Секреты в архив не попадают.</p>
        {backupProgress && <p className="sheet-description">Файлы: {backupProgress.filesDone}/{backupProgress.filesTotal} — {backupProgress.current}</p>}
        {backupError && <p className="media-error" role="alert">{backupError}</p>}
        <button className="sheet-submit" onClick={() => void runFullBackup()} disabled={backupBusy}><Icon name="download" size={18} />{backupBusy ? "Собираю бэкап…" : "Скачать полный бэкап (ZIP)"}</button>
      </div>
    </section></div>}

    {readingEntry && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setReadingEntry(null)}>
      <section className="compact-sheet entry-reader" role="dialog" aria-modal="true" aria-labelledby="entry-reader-title">
        <div className="modal-handle" />
        <div className="editor-head"><div><span>{displayDate(readingEntry.date)}</span><h2 id="entry-reader-title">{readingEntry.title?.trim() || "Запись дневника"}</h2></div><button className="icon-button" onClick={() => setReadingEntry(null)} aria-label="Закрыть запись"><Icon name="close" /></button></div>
        {readingEntry.mood && <span className="reader-mood">{readingEntry.mood}</span>}
        {(readingEntry.body ?? "").trim() && <div className="entry-reader-body">{readingEntry.body}</div>}
        {syncEnabled && <EntryMediaBlock config={apiConfig} entry={readingEntry} onMediaUpdated={(media) => updateEntryMedia(readingEntry.id, media)} />}
        {!!readingEntry.tags.length && <div className="entry-tags reader-tags">{readingEntry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
        <div className="reader-export">
          <span className="transcript-label">Экспорт записи</span>
          <div className="reader-export-actions">
            <button className="ghost-action" onClick={() => exportEntry(readingEntry, "md")}><Icon name="download" size={14} />Markdown</button>
            <button className="ghost-action" onClick={() => exportEntry(readingEntry, "txt")}><Icon name="download" size={14} />Текст</button>
            <button className="ghost-action" onClick={() => exportEntry(readingEntry, "json")}><Icon name="download" size={14} />JSON</button>
            {!!(readingEntry.media ?? []).length && <button className="ghost-action" onClick={() => void downloadEntryMedia(readingEntry)}><Icon name="download" size={14} />Скачать медиа</button>}
          </div>
        </div>
      </section>
    </div>}
  </section>;
}

function localIso(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function CalendarScreen({ events, setEvents, selectedDate, setSelectedDate }: { events: CalendarEvent[]; setEvents: Dispatch<SetStateAction<CalendarEvent[]>>; selectedDate: string; setSelectedDate: Dispatch<SetStateAction<string>> }) {
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
        const hasItems = events.some((event) => event.date === iso);
        return <button key={iso} className={`${iso === selectedDate ? "selected" : ""} ${iso === todayIso() ? "today" : ""}`} onClick={() => setSelectedDate(iso)}><span>{day}</span>{hasItems && <i />}</button>;
      })}</div>
    </section>

    <div className="selected-day-head"><div><span>Выбранный день</span><h2>{displayDate(selectedDate)}</h2></div><button onClick={() => setAddOpen(true)}>+ Событие</button></div>
    <div className="day-agenda">
      {selectedEvents.map((event) => <button type="button" className="agenda-item event agenda-event-delete" key={event.id} onClick={() => removeEvent(event)} aria-label={`Удалить событие «${event.title}»`}><div className="agenda-time">{event.time || "—"}</div><div><h3>{event.title}</h3><p>{event.reminder === "Не напоминать" ? "В момент события" : (event.reminder || "В момент события")}</p></div><span className="agenda-delete" aria-hidden="true"><Icon name="close" size={15} /></span></button>)}
      {!selectedEvents.length && <div className="empty-card mini-empty"><Icon name="calendar" size={24} /><h3>Событий нет</h3><p>Можно оставить этот день свободным.</p></div>}
    </div>

    {addOpen && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}><form className="compact-sheet" onSubmit={addEvent}>
      <div className="modal-handle" /><div className="editor-head"><div><span>{displayDate(selectedDate)}</span><h2>Новое событие</h2></div><button type="button" className="icon-button" onClick={() => setAddOpen(false)}><Icon name="close" /></button></div>
      <label className="field"><span>Название</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, тренировка" /></label>
      <div className="field-pair"><label className="field"><span>Дата</span><input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} /></label><label className="field"><span>Время</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label></div>
      <label className="field"><span>Заметка</span><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Необязательно" /></label>
      <label className="field"><span>Дополнительное напоминание</span><select value={reminder} onChange={(e) => setReminder(e.target.value)}><option>За 10 минут</option><option>За 30 минут</option><option>За 1 час</option><option>Только в момент события</option></select></label>
      <p className="sheet-description">В момент события Telegram напомнит ещё раз.</p>
      <button className="sheet-submit">Добавить событие</button>
    </form></div>}
  </section>;
}

type ProgressPeriod = "day" | "week" | "month" | "year";
type ProgressSection = "tasks" | "days" | "entries" | "goals";

const progressPeriodLabels: Record<ProgressPeriod, string> = { day: "День", week: "Неделя", month: "Месяц", year: "Год" };

function dateFromIso(iso: string) {
  return new Date(`${iso}T12:00:00`);
}

function shiftProgressDate(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function progressPeriodBounds(period: ProgressPeriod) {
  const today = dateFromIso(todayIso());
  const start = new Date(today);
  const end = new Date(today);
  if (period === "week") {
    const mondayOffset = (today.getDay() + 6) % 7;
    start.setDate(today.getDate() - mondayOffset);
    end.setDate(start.getDate() + 6);
  } else if (period === "month") {
    start.setDate(1);
    end.setMonth(today.getMonth() + 1, 0);
  } else if (period === "year") {
    start.setMonth(0, 1);
    end.setMonth(11, 31);
  }
  return { start: localDateIso(start), end: localDateIso(end) };
}

function isInProgressPeriod(date: string, start: string, end: string) {
  return date >= start && date <= end;
}

function shortProgressDate(iso: string) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(dateFromIso(iso));
}

function progressPeriodCaption(period: ProgressPeriod, start: string, end: string) {
  if (period === "day") return new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(dateFromIso(start));
  if (period === "week") return `${shortProgressDate(start)} — ${shortProgressDate(end)}`;
  if (period === "month") return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(dateFromIso(start));
  return new Intl.DateTimeFormat("ru-RU", { year: "numeric" }).format(dateFromIso(start));
}

function goalProgressDate(goal: Goal) {
  const updated = goal.updatedAt?.slice(0, 10);
  return goal.completed && updated && /^\d{4}-\d{2}-\d{2}$/.test(updated) ? updated : goal.deadline;
}

function buildProgressBuckets(period: ProgressPeriod, start: string, end: string, tasks: PlanTask[]) {
  const ranges: { start: string; end: string; label: string }[] = [];
  if (period === "day") {
    ranges.push({ start, end, label: "Сегодня" });
  } else if (period === "week") {
    const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    for (let index = 0; index < 7; index += 1) {
      const date = localDateIso(shiftProgressDate(dateFromIso(start), index));
      ranges.push({ start: date, end: date, label: labels[index] });
    }
  } else if (period === "month") {
    let cursor = dateFromIso(start);
    while (localDateIso(cursor) <= end) {
      const bucketStart = localDateIso(cursor);
      const bucketEnd = localDateIso(new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(cursor.getDate() + 6, dateFromIso(end).getDate()), 12));
      ranges.push({ start: bucketStart, end: bucketEnd, label: `${cursor.getDate()}–${dateFromIso(bucketEnd).getDate()}` });
      cursor = shiftProgressDate(dateFromIso(bucketEnd), 1);
    }
  } else {
    const monthLabels = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
    const year = dateFromIso(start).getFullYear();
    for (let month = 0; month < 12; month += 1) {
      ranges.push({ start: localDateIso(new Date(year, month, 1, 12)), end: localDateIso(new Date(year, month + 1, 0, 12)), label: monthLabels[month] });
    }
  }
  return ranges.map((range) => {
    const bucketTasks = tasks.filter((task) => isInProgressPeriod(task.date, range.start, range.end));
    const done = bucketTasks.filter((task) => task.completed).length;
    return { ...range, percent: bucketTasks.length ? Math.round(done / bucketTasks.length * 100) : 0, total: bucketTasks.length };
  });
}

export function ProgressScreen({ tasks, goals, entries }: { tasks: PlanTask[]; goals: Goal[]; entries: JournalEntry[] }) {
  const [period, setPeriod] = useState<ProgressPeriod>("week");
  const [openSection, setOpenSection] = useState<ProgressSection | null>("tasks");
  const { start, end } = progressPeriodBounds(period);
  const periodTasks = tasks.filter((task) => isInProgressPeriod(task.date, start, end)).sort((a, b) => b.date.localeCompare(a.date));
  const periodEntries = entries.filter((entry) => isInProgressPeriod(entry.date, start, end)).sort((a, b) => b.date.localeCompare(a.date));
  const periodGoals = goals.filter((goal) => isInProgressPeriod(goalProgressDate(goal), start, end)).sort((a, b) => goalProgressDate(b).localeCompare(goalProgressDate(a)));
  const completedTasks = periodTasks.filter((task) => task.completed).length;
  const percent = periodTasks.length ? Math.round(completedTasks / periodTasks.length * 100) : 0;
  const planDays = [...new Set(periodTasks.map((task) => task.date))].sort((a, b) => b.localeCompare(a));
  const completedGoals = periodGoals.filter((goal) => goal.completed).length;
  const missedGoals = periodGoals.filter((goal) => !goal.completed && goal.deadline < todayIso()).length;
  const buckets = buildProgressBuckets(period, start, end, periodTasks);

  function toggleSection(section: ProgressSection) {
    setOpenSection((current) => current === section ? null : section);
  }

  return <section className="screen secondary-screen progress-screen" aria-labelledby="progress-title">
    <div className="eyebrow"><span className="status-dot" /> Без оценок — только факты</div>
    <div className="secondary-title"><div><h1 id="progress-title">Прогресс</h1><p>Открывай разделы и смотри, что сделано.</p></div><div className="streak"><strong>{planDays.length}</strong><span>дней</span></div></div>

    <div className="segmented-tabs progress-period-tabs" role="tablist" aria-label="Период прогресса">
      {(Object.keys(progressPeriodLabels) as ProgressPeriod[]).map((value) => <button key={value} role="tab" aria-selected={period === value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{progressPeriodLabels[value]}</button>)}
    </div>

    <section className="week-score"><span>{progressPeriodCaption(period, start, end)}</span><div><strong>{percent}%</strong><p>{completedTasks} из {periodTasks.length} задач выполнено</p></div><div className={`week-chart progress-chart period-${period}`} aria-label="Динамика выполнения">{buckets.map((bucket) => <span key={bucket.start} className={bucket.start <= todayIso() && bucket.end >= todayIso() ? "current" : ""} style={{ height: `${bucket.total ? Math.max(bucket.percent, 10) : 6}%` }} aria-label={`${bucket.label}: ${bucket.percent}%`}><i>{bucket.label}</i></span>)}</div></section>

    <div className="stats-grid progress-stats">
      <button type="button" className={openSection === "tasks" ? "active" : ""} onClick={() => toggleSection("tasks")} aria-expanded={openSection === "tasks"}><Icon name="check" size={20} /><strong>{completedTasks}</strong><span>задач выполнено из {periodTasks.length}</span><Icon name="arrow" size={15} /></button>
      <button type="button" className={openSection === "days" ? "active" : ""} onClick={() => toggleSection("days")} aria-expanded={openSection === "days"}><Icon name="calendar" size={20} /><strong>{planDays.length}</strong><span>дней с планом</span><Icon name="arrow" size={15} /></button>
      <button type="button" className={openSection === "entries" ? "active" : ""} onClick={() => toggleSection("entries")} aria-expanded={openSection === "entries"}><Icon name="book" size={20} /><strong>{periodEntries.length}</strong><span>записей дневника</span><Icon name="arrow" size={15} /></button>
      <button type="button" className={openSection === "goals" ? "active" : ""} onClick={() => toggleSection("goals")} aria-expanded={openSection === "goals"}><Icon name="target" size={20} /><strong>{completedGoals}</strong><span>{missedGoals ? `${missedGoals} не выполнено` : "целей достигнуто"}</span><Icon name="arrow" size={15} /></button>
    </div>

    {openSection && <section className="progress-details" aria-live="polite">
      <div className="progress-details-head"><span>{openSection === "tasks" ? "Задачи" : openSection === "days" ? "Дни с планом" : openSection === "entries" ? "Записи дневника" : "Цели"}</span><strong>{progressPeriodCaption(period, start, end)}</strong></div>
      {openSection === "tasks" && <div className="progress-detail-list">{periodTasks.map((task) => <article key={task.id}><span className={`progress-result ${task.completed ? "done" : "pending"}`}>{task.completed ? "Выполнено" : "Не выполнено"}</span><h3>{task.title}</h3><p>{shortProgressDate(task.date)}</p></article>)}</div>}
      {openSection === "days" && <div className="progress-detail-list">{planDays.map((date) => { const dayTasks = periodTasks.filter((task) => task.date === date); const done = dayTasks.filter((task) => task.completed).length; return <article key={date}><span className="progress-result">{done}/{dayTasks.length}</span><h3>{displayDate(date)}</h3><p>{done} выполнено · {dayTasks.length - done} не выполнено</p></article>; })}</div>}
      {openSection === "entries" && <div className="progress-detail-list">{periodEntries.map((entry) => <article key={entry.id}><span className="progress-result">{shortProgressDate(entry.date)}</span><h3>{entry.title?.trim() || "Запись дневника"}</h3><p>{(entry.body ?? "").trim() || (entry.media?.length ? "Аудио или видеозапись" : "Без текста")}</p></article>)}</div>}
      {openSection === "goals" && <div className="progress-detail-list">{periodGoals.map((goal) => { const missed = !goal.completed && goal.deadline < todayIso(); return <article key={goal.id}><span className={`progress-result ${goal.completed ? "done" : missed ? "missed" : "pending"}`}>{goal.completed ? "Выполнена" : missed ? "Не выполнена" : "В работе"}</span><h3>{goal.title}</h3><p>{goal.completed ? `Завершена ${shortProgressDate(goalProgressDate(goal))}` : `Срок ${shortProgressDate(goal.deadline)}`} · {goal.progress}%</p></article>; })}</div>}
      {((openSection === "tasks" && !periodTasks.length) || (openSection === "days" && !planDays.length) || (openSection === "entries" && !periodEntries.length) || (openSection === "goals" && !periodGoals.length)) && <div className="mini-empty"><p>За этот период пока ничего нет.</p></div>}
    </section>}
    <p className="no-ai-note">Статистика считается только по твоим данным — без AI-анализа.</p>
  </section>;
}

const ideaCategoryLabels: Record<IdeaCategory, string> = { thought: "Мысль", want: "Хочуха", project: "Проект", purchase: "Покупка", someday: "Когда-нибудь" };

const ideaStatusLabels: Record<IdeaStatus, string> = { new: "Новая", thinking: "Думаю", plan: "В план", done: "Сделано", archive: "Архив" };

export function IdeasScreen({ ideas, setIdeas, sectionTabs }: { ideas: Idea[]; setIdeas: Dispatch<SetStateAction<Idea[]>>; sectionTabs?: ReactNode }) {
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
    {sectionTabs}

    <div className="mood-row idea-filters"><span>Категория</span><div>
      <button className={categoryFilter === "all" ? "active" : ""} onClick={() => setCategoryFilter("all")}>Все</button>
      {(Object.keys(ideaCategoryLabels) as IdeaCategory[]).map((value) => <button key={value} className={`category-${value} ${categoryFilter === value ? "active" : ""}`} onClick={() => setCategoryFilter(categoryFilter === value ? "all" : value)}>{ideaCategoryLabels[value]}</button>)}
    </div></div>

    <div className="mood-row idea-filters"><span>Статус</span><div>
      <button className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>Все</button>
      {(Object.keys(ideaStatusLabels) as IdeaStatus[]).map((value) => <button key={value} className={statusFilter === value ? "active" : ""} onClick={() => setStatusFilter(statusFilter === value ? "all" : value)}>{ideaStatusLabels[value]}</button>)}
    </div></div>

    <div className="idea-list">
      {visible.map((idea) => <article className={`idea-card category-${idea.category}`} key={idea.id}>
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
    setSyncStatus("Проверка...");
    try {
      await onSaveApiConfig(defaultApiConfig);
      setSyncStatus("Подключено");
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
      <div className="sync-row">
        <div><h3>Workazy Cloud</h3><p>{apiConfig.enabled ? "Подключено автоматически · данные хранятся на сервере" : "Переподключение…"}</p></div>
        <span className={`sync-indicator ${apiConfig.enabled ? "online" : ""}`} aria-label={apiConfig.enabled ? "Синхронизация подключена" : "Синхронизация переподключается"} />
      </div>
      <div className="sync-actions">
        <button onClick={saveServerConfig} disabled={syncSaving}>{syncSaving ? "Проверка" : "Проверить связь"}</button>
        {syncStatus && <span>{syncStatus}</span>}
      </div>
    </div>
    <div className="integration-note"><Icon name="spark" size={18} /><p>Каждый час приходит сводка по плану. Повторный запуск в тот же час не создаёт дубль.</p></div>
  </section></div>;
}
