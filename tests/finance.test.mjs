import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const financeSource = await readFile(new URL("lib/finance.ts", root), "utf8");
const executableSource = financeSource.replace(/^import[^\n]+\n/gm, "");
const helpers = `
const localDateIso = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
};
const todayIso = () => "2026-08-29";
`;
const output = ts.transpileModule(`${helpers}\n${executableSource}`, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const finance = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

function salary(dayOfMonth, amount = 5000, id = `salary-${dayOfMonth}`) {
  return { id, dayOfMonth, amount, title: "Зарплата", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" };
}

test("daily finance limit uses current balance and days until the next salary", () => {
  const next = finance.nextSalaryOccurrence([salary(7), salary(14), salary(21)], "2026-08-08");
  assert.equal(next.iso, "2026-08-14");
  assert.equal(finance.daysUntil(next.iso, "2026-08-08"), 6);
  assert.equal(finance.dailyBudget(15_000, next.iso, "2026-08-08"), 2_500);
});

test("salary days repeat monthly and clamp to the last real calendar day", () => {
  assert.equal(finance.salaryDateInMonth(salary(31), 2027, 1), "2027-02-28");
  assert.equal(finance.nextSalaryOccurrence([salary(31)], "2027-02-20").iso, "2027-02-28");
});

test("finance state normalization rejects negative and malformed amounts", () => {
  assert.deepEqual(finance.normalizeFinanceState({ balance: -10, salarySchedules: "bad", expenses: [] }), {
    balance: 0,
    salarySchedules: [],
    expenses: [],
    obligations: [],
    updatedAt: undefined,
  });
});

test("finance obligations are normalized and malformed records are ignored", () => {
  const result = finance.normalizeFinanceState({
    balance: 0,
    salarySchedules: [],
    expenses: [],
    obligations: [
      { id: "debt-1", kind: "debt", title: "  Вернуть другу  ", amount: 1200.555, dueDate: "2026-09-12", reminderTime: "09:30", completed: false, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" },
      { id: "bad", kind: "other", title: "Ошибка", amount: 500, completed: false, createdAt: "x", updatedAt: "x" },
    ],
  });
  assert.deepEqual(result.obligations, [{ id: "debt-1", kind: "debt", title: "Вернуть другу", amount: 1200.56, dueDate: "2026-09-12", reminderTime: "09:30", completed: false, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" }]);
});

test("finance tab is wired to forms, calendar and durable cloud state", async () => {
  const app = await readFile(new URL("app/planner-app.tsx", root), "utf8");
  const screen = await readFile(new URL("app/finance-screen.tsx", root), "utf8");
  const api = await readFile(new URL("lib/planner-api.ts", root), "utf8");
  const route = await readFile(new URL("app/api/v1/state/route.ts", root), "utf8");
  const css = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(app, /id: "finance", label: "Финансы"/);
  assert.match(app, /<FinanceScreen finances=\{finances\} setFinances=\{setFinances\}/);
  assert.match(screen, /Сколько денег сейчас/);
  assert.match(screen, /Записать расход/);
  assert.match(screen, /Дни зарплаты/);
  assert.match(screen, /Долги \/ обязательства/);
  assert.match(screen, /Добавить обязательство/);
  assert.match(screen, /finance-calendar-grid/);
  assert.match(api, /finances: state\.finances/);
  assert.match(financeSource, /planner-finance-state/);
  assert.match(route, /FINANCE_STATE_KEY/);
  assert.match(route, /body\.finances === undefined \? null/);
  assert.match(route, /JSON\.stringify\(financeState\)/);
  assert.match(css, /grid-template-columns: repeat\(4, 1fr\)/);
});
