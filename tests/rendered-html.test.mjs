import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const appSource = await readFile(new URL("../app/planner-app.tsx", import.meta.url), "utf8");
const secondarySource = await readFile(new URL("../app/secondary-screens.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("plan task card opens the full text while its checkbox stays independent", () => {
  assert.match(appSource, /function handleTaskCardClick/);
  assert.match(appSource, /target\.closest\("button, input, label, \.task-menu"\)/);
  assert.match(appSource, /setReadingTaskId\(id\)/);
  assert.match(appSource, /role="button"/);
  assert.match(appSource, /aria-haspopup="dialog"/);
  assert.match(appSource, /TaskTextSheet/);
  assert.match(cssSource, /\.task-reader-body \{[^}]*white-space: pre-wrap/s);
  assert.doesNotMatch(appSource, /<article[^>]*\sdraggable[\s=>]/);
});

test("task action menu can open upward near the bottom navigation", () => {
  assert.match(appSource, /setMenuPlacement\(spaceBelow < menuHeight && spaceAbove > spaceBelow \? "up" : "down"\)/);
  assert.match(cssSource, /\.task-menu\.drop-up \.task-menu-popover/);
  assert.match(cssSource, /bottom: 37px/);
});

test("plan task rows stay compact on mobile", () => {
  assert.match(cssSource, /\.task-card \{ min-height: 60px/);
  assert.match(cssSource, /\.task-body p \{[^}]*font-size: 13px/s);
  assert.match(cssSource, /\.task-body p \{[^}]*-webkit-line-clamp: 2/s);
});

test("plan supports quick item append and manual reset", () => {
  assert.match(appSource, /function addQuickTask/);
  assert.match(appSource, /Добавить пункт в план/);
  assert.match(appSource, /function resetPlan/);
  assert.match(appSource, /Сбросить план/);
  assert.match(appSource, /PLAN_DATE_STORAGE_KEY/);
});

test("plan header formats the selected date instead of showing a fixed calendar day", () => {
  assert.match(appSource, /function displayFullDate/);
  assert.match(appSource, /displayFullDate\(selectedDate\)/);
  assert.doesNotMatch(appSource, /Суббота, 22 августа/);
});

test("journal entries can be opened in a full reader", () => {
  assert.match(secondarySource, /readingEntry/);
  assert.match(secondarySource, /entry-reader/);
  assert.match(secondarySource, /role="dialog"/);
  assert.match(cssSource, /\.entry-reader-body \{[^}]*white-space: pre-wrap/s);
});

test("journal reader scrolls as one sheet when media and transcript are long", () => {
  assert.match(cssSource, /\.entry-reader \{[^}]*overflow-y: auto/s);
  assert.match(cssSource, /\.entry-reader \{[^}]*-webkit-overflow-scrolling: touch/s);
  assert.match(cssSource, /\.entry-reader video\.media-player \{[^}]*max-height:/s);
  assert.doesNotMatch(cssSource, /\.entry-reader \{[^}]*overflow: hidden/s);
});

test("assignments are independent from the daily plan and support manual input", () => {
  assert.match(appSource, /id: "tasks", label: "Задания"/);
  assert.doesNotMatch(appSource, /id: "progress", label: "Прогресс"/);
  assert.match(secondarySource, /export function TasksScreen/);
  assert.match(secondarySource, /Активные/);
  assert.match(secondarySource, /Готовые/);
  assert.match(appSource, /useState<Assignment\[]>\(initialAssignments\)/);
  assert.match(appSource, /<TasksScreen assignments=\{assignments\} setAssignments=\{setAssignments\}/);
  assert.match(secondarySource, /function addAssignment/);
  assert.match(secondarySource, /setReadingAssignmentId\(assignment\.id\)/);
  assert.match(secondarySource, /Задания из Workazy GPT и добавленные вручную/);
  assert.match(cssSource, /\.assignment-list/);
});

test("bottom navigation groups the planner into four related sections", () => {
  for (const label of ["Планы", "Календарь", "Записи", "Финансы"]) {
    assert.match(appSource, new RegExp(`label: "${label}"`));
  }
  assert.match(appSource, /const planningTabs/);
  assert.match(appSource, /id: "plan", label: "План"/);
  assert.match(appSource, /id: "tasks", label: "Задания"/);
  assert.match(appSource, /id: "goals", label: "Цели"/);
  assert.match(appSource, /const recordTabs/);
  assert.match(appSource, /id: "journal", label: "Дневник"/);
  assert.match(appSource, /id: "ideas", label: "Идеи"/);
  assert.match(appSource, /lastTabBySection/);
  assert.match(cssSource, /\.bottom-nav \{[^}]*grid-template-columns: repeat\(4, 1fr\)/s);
  assert.match(cssSource, /\.workspace-tabs/);
  assert.match(appSource, /<div className="title-row">[\s\S]*?\{planningSectionTabs\}[\s\S]*?<div className="date-switcher"/);
  assert.match(secondarySource, /<h1 id="assignments-title">Задания<\/h1>[\s\S]*?\{sectionTabs\}[\s\S]*?<form className="quick-task-form/);
  assert.match(secondarySource, /<h1 id="journal-title">Дневник<\/h1>[\s\S]*?\{sectionTabs\}[\s\S]*?<div className="segmented-tabs journal-tabs"/);
});

test("calendar shows events only and plan items never leak into it", () => {
  assert.match(appSource, /<CalendarScreen events=\{events\}/);
  assert.doesNotMatch(appSource, /<CalendarScreen tasks=\{tasks\}/);
  const calendarStart = secondarySource.indexOf("export function CalendarScreen");
  const calendarEnd = secondarySource.indexOf("type ProgressPeriod", calendarStart);
  const calendarSource = secondarySource.slice(calendarStart, calendarEnd);
  assert.doesNotMatch(calendarSource, /selectedTasks|Пункт плана|tasks\.some/);
  assert.match(calendarSource, /const hasItems = events\.some/);
});

test("idea categories have distinct card and filter colors", () => {
  assert.match(secondarySource, /className=\{`category-\$\{value\}/);
  assert.match(secondarySource, /className=\{`idea-card category-\$\{idea\.category\}/);
  for (const category of ["thought", "want", "project", "purchase", "someday"]) {
    assert.match(cssSource, new RegExp(`\\.idea-card\\.category-${category}`));
    assert.match(cssSource, new RegExp(`\\.idea-filters button\\.category-${category}\\.active`));
  }
});

test("goal outcomes are timestamped and shown as completed, missed or active", () => {
  assert.match(secondarySource, /updatedAt: todayIso\(\)/);
  assert.match(secondarySource, /goalProgressDate/);
  assert.match(secondarySource, /"Не выполнена"/);
  assert.match(secondarySource, /"В работе"/);
  assert.match(cssSource, /\.progress-result\.missed/);
});
