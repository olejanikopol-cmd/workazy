"use client";

import { useEffect, useMemo, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { FinanceState } from "@/lib/types";
import { dailyBudget, daysUntil, money, nextSalaryOccurrence, roundMoney, salaryDateInMonth } from "@/lib/finance";
import { DEFAULT_OBLIGATION_REMINDER_TIME } from "@/lib/reminder-scheduler";
import { localDateIso, todayIso } from "@/lib/planner-data";
import { Icon, uid } from "./planner-app";

const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function monthCells(cursor: Date) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  return [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: days }, (_, index) => localDateIso(new Date(year, month, index + 1, 12, 0, 0, 0))),
  ];
}

function parseAmount(value: string) {
  const amount = Number(value.replace(",", "."));
  return Number.isFinite(amount) && amount >= 0 ? roundMoney(amount) : null;
}

export function FinanceScreen({ finances, setFinances }: {
  finances: FinanceState;
  setFinances: Dispatch<SetStateAction<FinanceState>>;
}) {
  const today = todayIso();
  const [month, setMonth] = useState(() => {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
  });
  const [selectedDate, setSelectedDate] = useState(today);
  const [balanceInput, setBalanceInput] = useState(finances.balance ? String(finances.balance) : "");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseNote, setExpenseNote] = useState("");
  const [expenseDate, setExpenseDate] = useState(today);
  const [salaryDay, setSalaryDay] = useState("");
  const [salaryAmount, setSalaryAmount] = useState("");
  const [salaryTitle, setSalaryTitle] = useState("Зарплата");
  const [activeSection, setActiveSection] = useState<"budget" | "obligations">("budget");
  const [obligationKind, setObligationKind] = useState<"debt" | "purchase">("debt");
  const [obligationTitle, setObligationTitle] = useState("");
  const [obligationAmount, setObligationAmount] = useState("");
  const [obligationDueDate, setObligationDueDate] = useState("");
  const [obligationReminderTime, setObligationReminderTime] = useState(DEFAULT_OBLIGATION_REMINDER_TIME);

  const nextSalary = useMemo(() => nextSalaryOccurrence(finances.salarySchedules, today), [finances.salarySchedules, today]);
  const remainingDays = daysUntil(nextSalary?.iso, today);
  const allowance = dailyBudget(finances.balance, nextSalary?.iso, today);
  const todaySpent = finances.expenses.filter((expense) => expense.date === today).reduce((sum, expense) => sum + expense.amount, 0);
  const selectedExpenses = [...finances.expenses].filter((expense) => expense.date === selectedDate).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selectedSalaries = finances.salarySchedules.filter((schedule) => salaryDateInMonth(schedule, Number(selectedDate.slice(0, 4)), Number(selectedDate.slice(5, 7)) - 1) === selectedDate);
  const cells = monthCells(month);
  const activeObligations = finances.obligations.filter((item) => !item.completed);
  const debtTotal = activeObligations.filter((item) => item.kind === "debt").reduce((sum, item) => sum + item.amount, 0);
  const purchaseTotal = activeObligations.filter((item) => item.kind === "purchase").reduce((sum, item) => sum + item.amount, 0);
  const sortedObligations = [...finances.obligations].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") || b.createdAt.localeCompare(a.createdAt);
  });

  useEffect(() => {
    setBalanceInput(finances.balance ? String(finances.balance) : "");
  }, [finances.balance]);

  function touch(next: FinanceState): FinanceState {
    return { ...next, updatedAt: new Date().toISOString() };
  }

  function saveBalance(event: FormEvent) {
    event.preventDefault();
    const amount = parseAmount(balanceInput);
    if (amount === null) return;
    setFinances((current) => touch({ ...current, balance: amount }));
  }

  function addExpense(event: FormEvent) {
    event.preventDefault();
    const amount = parseAmount(expenseAmount);
    if (!amount) return;
    if (amount > finances.balance && !window.confirm("Расход больше текущего баланса. Сохранить и установить баланс 0 ₴?")) return;
    const now = new Date().toISOString();
    setFinances((current) => touch({
      ...current,
      balance: roundMoney(Math.max(0, current.balance - amount)),
      expenses: [{ id: uid("expense"), date: expenseDate, amount, note: expenseNote.trim() || undefined, createdAt: now }, ...current.expenses],
    }));
    setExpenseAmount("");
    setExpenseNote("");
    setSelectedDate(expenseDate);
  }

  function removeExpense(id: string) {
    const expense = finances.expenses.find((item) => item.id === id);
    if (!expense) return;
    setFinances((current) => touch({
      ...current,
      balance: roundMoney(current.balance + expense.amount),
      expenses: current.expenses.filter((item) => item.id !== id),
    }));
  }

  function addSalary(event: FormEvent) {
    event.preventDefault();
    const day = Number(salaryDay);
    const amount = parseAmount(salaryAmount);
    if (!Number.isInteger(day) || day < 1 || day > 31 || amount === null) return;
    const now = new Date().toISOString();
    setFinances((current) => touch({
      ...current,
      salarySchedules: [...current.salarySchedules, {
        id: uid("salary"),
        dayOfMonth: day,
        amount,
        title: salaryTitle.trim() || "Зарплата",
        createdAt: now,
        updatedAt: now,
      }].sort((a, b) => a.dayOfMonth - b.dayOfMonth),
    }));
    setSalaryDay("");
    setSalaryAmount("");
  }

  function addObligation(event: FormEvent) {
    event.preventDefault();
    const title = obligationTitle.trim();
    const amount = parseAmount(obligationAmount);
    if (!title || !amount) return;
    const now = new Date().toISOString();
    setFinances((current) => touch({
      ...current,
      obligations: [{
        id: uid("obligation"),
        kind: obligationKind,
        title,
        amount,
        dueDate: obligationDueDate || undefined,
        reminderTime: obligationDueDate ? obligationReminderTime : undefined,
        completed: false,
        createdAt: now,
        updatedAt: now,
      }, ...current.obligations],
    }));
    setObligationTitle("");
    setObligationAmount("");
    setObligationDueDate("");
  }

  function toggleObligation(id: string) {
    const now = new Date().toISOString();
    setFinances((current) => touch({
      ...current,
      obligations: current.obligations.map((item) => item.id === id ? { ...item, completed: !item.completed, updatedAt: now } : item),
    }));
  }

  function removeObligation(id: string) {
    setFinances((current) => touch({ ...current, obligations: current.obligations.filter((item) => item.id !== id) }));
  }

  function shiftMonth(delta: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1, 12, 0, 0, 0));
  }

  return <section className="screen secondary-screen finance-screen" aria-labelledby="finance-title">
    <div className="eyebrow finance-eyebrow"><span className="status-dot" /> Личный бюджет</div>
    <div className="secondary-title finance-title-row">
      <div><h1 id="finance-title">Финансы</h1><p>Сколько есть, сколько ушло и сколько можно сегодня.</p></div>
      <div className="finance-balance-mini"><span>Баланс</span><strong>{money(finances.balance)} ₴</strong></div>
    </div>

    <div className="segmented-tabs finance-subtabs" role="tablist" aria-label="Раздел финансов">
      <button type="button" role="tab" aria-selected={activeSection === "budget"} className={activeSection === "budget" ? "active" : ""} onClick={() => setActiveSection("budget")}>Бюджет</button>
      <button type="button" role="tab" aria-selected={activeSection === "obligations"} className={activeSection === "obligations" ? "active" : ""} onClick={() => setActiveSection("obligations")}>Долги / обязательства <span>{activeObligations.length}</span></button>
    </div>

    {activeSection === "budget" ? <>
    <div className="finance-summary-grid">
      <article className="finance-limit-card">
        <span>Можно тратить в день</span>
        <strong>{nextSalary ? `${money(allowance)} ₴` : "—"}</strong>
        <p>{nextSalary ? `До ${nextSalary.schedule.title.toLowerCase()} — ${remainingDays} ${remainingDays === 1 ? "день" : remainingDays < 5 ? "дня" : "дней"}` : "Добавь ближайшие дни зарплаты"}</p>
        <div className="finance-today-line"><span>Сегодня потрачено</span><b>{money(todaySpent)} ₴</b></div>
      </article>

      <form className="finance-balance-card" onSubmit={saveBalance}>
        <label htmlFor="finance-balance">Сколько денег сейчас</label>
        <div><input id="finance-balance" inputMode="decimal" value={balanceInput} onChange={(event) => setBalanceInput(event.target.value)} placeholder="15000" /><span>₴</span></div>
        <button type="submit">Обновить баланс</button>
      </form>
    </div>

    <div className="section-heading"><h2>Записать расход</h2><span>баланс уменьшится сам</span></div>
    <form className="finance-expense-form" onSubmit={addExpense}>
      <label><span>Сумма</span><div className="finance-money-input"><input inputMode="decimal" value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} placeholder="350" required /><b>₴</b></div></label>
      <label><span>Дата</span><input type="date" value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} required /></label>
      <label className="finance-note-field"><span>На что</span><input value={expenseNote} onChange={(event) => setExpenseNote(event.target.value)} placeholder="Продукты, кофе, дорога…" /></label>
      <button type="submit" disabled={!parseAmount(expenseAmount)}>Добавить расход</button>
    </form>

    <div className="section-heading"><h2>Дни зарплаты</h2><span>повторяются каждый месяц</span></div>
    <form className="finance-salary-form" onSubmit={addSalary}>
      <label><span>День</span><input inputMode="numeric" type="number" min="1" max="31" value={salaryDay} onChange={(event) => setSalaryDay(event.target.value)} placeholder="7" required /></label>
      <label><span>Сумма</span><div className="finance-money-input"><input inputMode="decimal" value={salaryAmount} onChange={(event) => setSalaryAmount(event.target.value)} placeholder="5000" required /><b>₴</b></div></label>
      <label className="finance-salary-title"><span>Название</span><input value={salaryTitle} onChange={(event) => setSalaryTitle(event.target.value)} /></label>
      <button type="submit">Добавить дату</button>
    </form>
    {!!finances.salarySchedules.length && <div className="salary-chip-list">
      {finances.salarySchedules.map((schedule) => <button key={schedule.id} type="button" onClick={() => setFinances((current) => touch({ ...current, salarySchedules: current.salarySchedules.filter((item) => item.id !== schedule.id) }))} aria-label={`Удалить ${schedule.title} ${schedule.dayOfMonth} числа`}>
        <span>{schedule.dayOfMonth}</span><b>{schedule.title}</b><em>{money(schedule.amount)} ₴</em><Icon name="close" size={13} />
      </button>)}
    </div>}

    <div className="finance-calendar-card">
      <div className="calendar-head">
        <button type="button" onClick={() => shiftMonth(-1)} aria-label="Предыдущий месяц"><Icon name="arrow" size={17} /></button>
        <h2>{new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(month)}</h2>
        <button type="button" onClick={() => shiftMonth(1)} aria-label="Следующий месяц"><Icon name="arrow" size={17} /></button>
      </div>
      <div className="weekdays">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
      <div className="finance-calendar-grid">
        {cells.map((iso, index) => {
          if (!iso) return <span className="blank-day" key={`blank-${index}`} />;
          const spent = finances.expenses.filter((expense) => expense.date === iso).reduce((sum, expense) => sum + expense.amount, 0);
          const salaries = finances.salarySchedules.filter((schedule) => salaryDateInMonth(schedule, Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1) === iso);
          const planned = nextSalary && iso >= today && iso < nextSalary.iso ? allowance : 0;
          return <button type="button" key={iso} className={`${iso === selectedDate ? "selected" : ""} ${iso === today ? "today" : ""} ${salaries.length ? "salary-day" : ""}`} onClick={() => setSelectedDate(iso)}>
            <span>{Number(iso.slice(-2))}</span>
            {salaries.length ? <strong>+{money(salaries.reduce((sum, item) => sum + item.amount, 0))}</strong> : spent ? <strong className="spent">−{money(spent)}</strong> : planned ? <strong>{money(planned)}</strong> : null}
          </button>;
        })}
      </div>
      <div className="finance-calendar-legend"><span><i className="salary" /> зарплата</span><span><i className="expense" /> расход</span><span><i /> дневной лимит</span></div>
    </div>

    <div className="selected-day-head finance-selected-head"><div><span>Выбранный день</span><h2>{new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date(`${selectedDate}T12:00:00`))}</h2></div><strong>−{money(selectedExpenses.reduce((sum, item) => sum + item.amount, 0))} ₴</strong></div>
    <div className="finance-day-list">
      {selectedSalaries.map((schedule) => <article className="finance-day-income" key={schedule.id}><span>Доход</span><div><strong>{schedule.title}</strong><p>{money(schedule.amount)} ₴</p></div></article>)}
      {selectedExpenses.map((expense) => <article key={expense.id}><span>−{money(expense.amount)} ₴</span><div><strong>{expense.note || "Расход"}</strong><p>{new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(expense.createdAt))}</p></div><button type="button" onClick={() => removeExpense(expense.id)} aria-label={`Удалить расход ${money(expense.amount)} гривен`}><Icon name="close" size={15} /></button></article>)}
      {!selectedSalaries.length && !selectedExpenses.length && <div className="empty-card mini-empty"><h3>Записей за этот день нет</h3><p>Лимит и расходы появятся здесь.</p></div>}
    </div>
    </> : <>
      <div className="finance-obligation-summary">
        <article className="debt"><span>Нужно вернуть</span><strong>{money(debtTotal)} ₴</strong><p>{activeObligations.filter((item) => item.kind === "debt").length} открытых долгов</p></article>
        <article className="purchase"><span>Нужно купить</span><strong>{money(purchaseTotal)} ₴</strong><p>{activeObligations.filter((item) => item.kind === "purchase").length} запланированных покупок</p></article>
      </div>

      <div className="section-heading"><h2>Добавить обязательство</h2><span>долг или будущая покупка</span></div>
      <form className="finance-obligation-form" onSubmit={addObligation}>
        <div className="finance-kind-switch" role="group" aria-label="Тип обязательства">
          <button type="button" className={obligationKind === "debt" ? "active" : ""} aria-pressed={obligationKind === "debt"} onClick={() => setObligationKind("debt")}>Долг</button>
          <button type="button" className={obligationKind === "purchase" ? "active" : ""} aria-pressed={obligationKind === "purchase"} onClick={() => setObligationKind("purchase")}>Покупка</button>
        </div>
        <label className="finance-obligation-title"><span>{obligationKind === "debt" ? "Кому / за что" : "Что нужно купить"}</span><input value={obligationTitle} onChange={(event) => setObligationTitle(event.target.value)} placeholder={obligationKind === "debt" ? "Вернуть другу" : "Новый ноутбук"} maxLength={200} required /></label>
        <label><span>Сумма</span><div className="finance-money-input"><input inputMode="decimal" value={obligationAmount} onChange={(event) => setObligationAmount(event.target.value)} placeholder="5000" required /><b>₴</b></div></label>
        <label><span>Срок</span><input type="date" value={obligationDueDate} onChange={(event) => setObligationDueDate(event.target.value)} /></label>
        <label><span>Напомнить</span><input type="time" value={obligationReminderTime} onChange={(event) => setObligationReminderTime(event.target.value)} disabled={!obligationDueDate} /></label>
        <button type="submit" disabled={!obligationTitle.trim() || !parseAmount(obligationAmount)}>Добавить</button>
      </form>

      <div className="section-heading"><h2>Список</h2><span>{activeObligations.length ? `открыто ${activeObligations.length}` : "всё закрыто"}</span></div>
      <div className="finance-obligation-list">
        {sortedObligations.map((item) => {
          const overdue = Boolean(item.dueDate && item.dueDate < today && !item.completed);
          const kindLabel = item.kind === "debt" ? "Долг" : "Покупка";
          return <article key={item.id} className={`${item.completed ? "completed" : ""} ${overdue ? "overdue" : ""}`}>
            <div className="finance-obligation-copy">
              <div><span className={`finance-obligation-kind ${item.kind}`}>{kindLabel}</span>{overdue && <span className="finance-overdue">Просрочено</span>}</div>
              <h3>{item.title}</h3>
              <p>{item.dueDate ? `${overdue ? "Срок был" : "До"} ${new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${item.dueDate}T12:00:00`))} · Telegram в ${item.reminderTime ?? DEFAULT_OBLIGATION_REMINDER_TIME}` : "Без срока"}</p>
            </div>
            <strong>{money(item.amount)} ₴</strong>
            <div className="finance-obligation-actions">
              <button type="button" className="complete" onClick={() => toggleObligation(item.id)} aria-label={item.completed ? `Вернуть ${item.title} в открытые` : `${item.kind === "debt" ? "Отметить долг погашенным" : "Отметить покупку купленной"}: ${item.title}`}><Icon name="check" size={16} /><span>{item.completed ? "Вернуть" : item.kind === "debt" ? "Погашено" : "Куплено"}</span></button>
              <button type="button" className="remove" onClick={() => removeObligation(item.id)} aria-label={`Удалить ${item.title}`}><Icon name="close" size={15} /></button>
            </div>
          </article>;
        })}
        {!sortedObligations.length && <div className="empty-card mini-empty"><Icon name="wallet" size={24} /><h3>Пока ничего нет</h3><p>Добавь долг или вещь, которую планируешь купить.</p></div>}
      </div>
    </>}
  </section>;
}
