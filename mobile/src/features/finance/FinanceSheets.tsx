/**
 * Concrete Finance sheets. Each one collects a draft, validates it locally (money
 * text -> minor units, dates, times) and reports a typed failure back into the
 * sheet without closing it, so a failed save keeps the user's draft intact.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import AppText from '@/components/AppText';
import { colors, radius, spacing } from '@/theme';
import {
  FINANCE_CURRENCIES,
  type FinanceCurrency,
  type FinanceLimitMode,
  type FinanceObligationKind,
} from '@/types/finance';
import type {
  ExpenseDraft,
  ExpectationDraft,
  IncomeDraft,
  ObligationDraft,
  ReceiveDraft,
  ScheduleDraft,
} from './financeModel';
import { formatMoneyMinor, parseMoneyToMinor } from './financeMoney';
import { resolveSubmittedFinanceDate, submittedText, submittedOptionalText } from './financeDay';
import { localDateIso } from './financeDates';

import {
  FinanceSheetShell,
  LIMIT_MODE_LABELS,
  MoneyField,
  OBLIGATION_KIND_LABELS,
  TextField,
  readDate,
  readMoney,
  readTime,
} from './FinanceForms';

export type SheetOutcome = { ok: true } | { ok: false; message: string };

function Choice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View style={styles.choices}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.choice, selected ? styles.choiceSelected : null]}
          >
            <AppText variant="label" color={selected ? 'primary' : 'muted'}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function FinanceSetupSheet({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    currency: FinanceCurrency;
    balanceMinor: number;
    limitMode: FinanceLimitMode;
    manualLimitMinor: number | null;
    fallbackEndDate: string | null;
  }) => Promise<SheetOutcome>;
}) {
  const [currency, setCurrency] = useState<FinanceCurrency>('UAH');
  const [balanceText, setBalanceText] = useState('');
  const [limitMode, setLimitMode] = useState<FinanceLimitMode>('auto');
  const [manualLimitText, setManualLimitText] = useState('');
  const [fallbackEndDate, setFallbackEndDate] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    setErrorText(null);
    const balance = readMoney(balanceText, 'Баланс');
    if (!balance.ok) return setErrorText(balance.message);
    let manualLimitMinor: number | null = null;
    if (limitMode === 'manual') {
      const manual = readMoney(manualLimitText, 'Лимит');
      if (!manual.ok) return setErrorText(manual.message);
      if (manual.minor <= 0) return setErrorText('Лимит должен быть больше нуля.');
      manualLimitMinor = manual.minor;
    }
    const fallback = fallbackEndDate.trim().length === 0 ? null : readDate(fallbackEndDate, 'Дата дохода');
    if (fallback !== null && !fallback.ok) return setErrorText(fallback.message);
    const result = await onSubmit({
      currency,
      balanceMinor: balance.minor,
      limitMode,
      manualLimitMinor,
      fallbackEndDate: fallback === null ? null : fallback.date,
    });
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title="Настройка финансов"
      subtitle="Выберите валюту и текущий баланс. Баланс можно указать отрицательным — это разрешено."
      primaryLabel="Начать"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <AppText variant="label">Валюта</AppText>
      <Choice
        options={FINANCE_CURRENCIES.map((code) => ({ value: code, label: code }))}
        value={currency}
        onChange={setCurrency}
      />
      <AppText variant="meta" color="muted">
        Валюта фиксируется после первого сохранения финансов.
      </AppText>
      <MoneyField
        label="Текущий баланс"
        value={balanceText}
        onChange={setBalanceText}
        currency={currency}
        allowNegative
      />
      <AppText variant="label">Дневной лимит</AppText>
      <Choice
        options={[
          { value: 'auto', label: LIMIT_MODE_LABELS.auto },
          { value: 'manual', label: LIMIT_MODE_LABELS.manual },
        ]}
        value={limitMode}
        onChange={setLimitMode}
      />
      {limitMode === 'manual' ? (
        <MoneyField
          label="Сумма в день"
          value={manualLimitText}
          onChange={setManualLimitText}
          currency={currency}
        />
      ) : (
        <>
          <AppText variant="meta" color="muted">
            Авто: лимит = баланс ÷ дней до ближайшего ожидаемого дохода. Если дохода нет — укажите дату.
          </AppText>
          <TextField
            label="Дата следующего дохода (ГГГГ-ММ-ДД)"
            value={fallbackEndDate}
            onChange={setFallbackEndDate}
            placeholder="2026-10-01"
          />
        </>
      )}
    </FinanceSheetShell>
  );
}


export function FinanceExpenseSheet({
  mode,
  initial,
  currency,
  today,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial?: { amountText?: string; date?: string; category?: string; note?: string };
  currency: FinanceCurrency;
  today: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: ExpenseDraft) => Promise<SheetOutcome>;
}) {
  const [amountText, setAmountText] = useState(initial?.amountText ?? '');
  // An UNTOUCHED date field follows the live local today (midnight-safe); an explicit
  // choice is preserved. Nothing about the default is stored, so no effect is needed.
  const [dateTouched, setDateTouched] = useState(initial?.date !== undefined);
  const [dateValue, setDateValue] = useState(initial?.date ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [note, setNote] = useState(initial?.note ?? '');
  const [noteTouched, setNoteTouched] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const date = dateTouched ? dateValue : today;

  async function submit() {
    setErrorText(null);
    const amount = readMoney(amountText, 'Сумма');
    if (!amount.ok) return setErrorText(amount.message);
    if (amount.minor <= 0) return setErrorText('Сумма расхода должна быть больше нуля.');
    // Resolve and validate against the same submit-time local date.
    const submittedToday = localDateIso(new Date());
    const parsedDate = readDate(
      resolveSubmittedFinanceDate({
        originalDefaultDate: today,
        currentDraftDate: dateValue,
        wasDateTouched: dateTouched,
        nowLocalDate: submittedToday,
      }),
      'Дата',
    );
    if (!parsedDate.ok) return setErrorText(parsedDate.message);
    if (parsedDate.date > submittedToday) {
      return setErrorText('Расход — фактическая операция: дата не может быть в будущем.');
    }
    const result = await onSubmit({
      date: parsedDate.date,
      amountMinor: amount.minor,
      // Untouched optional text is passed EXACTLY as stored (no trim, no rewrite).
      category: submittedOptionalText(category, categoryTouched, initial?.category),
      note: submittedOptionalText(note, noteTouched, initial?.note),
    });
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title={mode === 'create' ? 'Новый расход' : 'Изменить расход'}
      subtitle="Расход уменьшает баланс на указанную сумму. Сегодняшний лимит не меняется."
      primaryLabel="Сохранить"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <MoneyField label="Сумма" value={amountText} onChange={setAmountText} currency={currency} />
      <TextField
        label="Дата (ГГГГ-ММ-ДД)"
        value={date}
        onChange={(value) => {
          setDateTouched(true);
          setDateValue(value);
        }}
        placeholder={today}
      />
      {dateTouched ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setDateTouched(false)}
          style={styles.inlineButton}
        >
          <AppText variant="label" color="accent">
            Сегодня — {today}
          </AppText>
        </Pressable>
      ) : null}
      <TextField
        label="Категория (необязательно)"
        value={category}
        onChange={(value) => {
          setCategoryTouched(true);
          setCategory(value);
        }}
        placeholder="Продукты"
      />
      <TextField
        label="Заметка (необязательно)"
        value={note}
        onChange={(value) => {
          setNoteTouched(true);
          setNote(value);
        }}
        multiline
      />
    </FinanceSheetShell>
  );
}

export function FinanceIncomeSheet({
  mode,
  initial,
  currency,
  today,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial?: { amountText?: string; date?: string; source?: string; note?: string };
  currency: FinanceCurrency;
  today: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: IncomeDraft) => Promise<SheetOutcome>;
}) {
  const [amountText, setAmountText] = useState(initial?.amountText ?? '');
  const [dateTouched, setDateTouched] = useState(initial?.date !== undefined);
  const [dateValue, setDateValue] = useState(initial?.date ?? '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [sourceTouched, setSourceTouched] = useState(false);
  const [note, setNote] = useState(initial?.note ?? '');
  const [noteTouched, setNoteTouched] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const date = dateTouched ? dateValue : today;

  async function submit() {
    setErrorText(null);
    const amount = readMoney(amountText, 'Сумма');
    if (!amount.ok) return setErrorText(amount.message);
    if (amount.minor <= 0) return setErrorText('Сумма дохода должна быть больше нуля.');
    // Resolve and validate against the same submit-time local date.
    const submittedToday = localDateIso(new Date());
    const parsedDate = readDate(
      resolveSubmittedFinanceDate({
        originalDefaultDate: today,
        currentDraftDate: dateValue,
        wasDateTouched: dateTouched,
        nowLocalDate: submittedToday,
      }),
      'Дата',
    );
    if (!parsedDate.ok) return setErrorText(parsedDate.message);
    if (parsedDate.date > submittedToday) {
      return setErrorText('Доход — фактическое поступление: дата не может быть в будущем.');
    }
    const result = await onSubmit({
      date: parsedDate.date,
      amountMinor: amount.minor,
      source: submittedOptionalText(source, sourceTouched, initial?.source),
      note: submittedOptionalText(note, noteTouched, initial?.note),
    });
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title={mode === 'create' ? 'Новый доход' : 'Изменить доход'}
      subtitle="Только фактический доход меняет баланс. Ожидаемый доход баланс не меняет."
      primaryLabel="Сохранить"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <MoneyField label="Сумма" value={amountText} onChange={setAmountText} currency={currency} />
      <TextField
        label="Дата (ГГГГ-ММ-ДД)"
        value={date}
        onChange={(value) => {
          setDateTouched(true);
          setDateValue(value);
        }}
        placeholder={today}
      />
      <TextField
        label="Источник (необязательно)"
        value={source}
        onChange={(value) => {
          setSourceTouched(true);
          setSource(value);
        }}
        placeholder="Аванс"
      />
      <TextField
        label="Заметка (необязательно)"
        value={note}
        onChange={(value) => {
          setNoteTouched(true);
          setNote(value);
        }}
        multiline
      />
    </FinanceSheetShell>
  );
}

export function FinanceObligationSheet({
  mode,
  initial,
  currency,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial?: {
    kind?: FinanceObligationKind;
    title?: string;
    amountText?: string;
    dueDate?: string;
    reminderTime?: string;
    reminderEnabled?: boolean;
    note?: string;
  };
  currency: FinanceCurrency;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: ObligationDraft) => Promise<SheetOutcome>;
}) {
  const [kind, setKind] = useState<FinanceObligationKind>(initial?.kind ?? 'payment');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [titleTouched, setTitleTouched] = useState(false);
  const [amountText, setAmountText] = useState(initial?.amountText ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? '');
  const [reminderEnabled, setReminderEnabled] = useState(initial?.reminderEnabled ?? false);
  const [reminderTime, setReminderTime] = useState(initial?.reminderTime ?? '09:00');
  const [note, setNote] = useState(initial?.note ?? '');
  const [noteTouched, setNoteTouched] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    setErrorText(null);
    const submittedTitle = submittedText(title, titleTouched);
    if (submittedTitle.trim().length === 0) return setErrorText('Укажите название.');
    const amount = readMoney(amountText, 'Сумма');
    if (!amount.ok) return setErrorText(amount.message);
    if (amount.minor <= 0) return setErrorText('Сумма обязательства должна быть больше нуля.');
    const parsedDue = dueDate.trim().length === 0 ? null : readDate(dueDate, 'Срок');
    if (parsedDue !== null && !parsedDue.ok) return setErrorText(parsedDue.message);
    if (reminderEnabled && parsedDue === null) {
      return setErrorText('Для напоминания нужна дата. Напоминание выключено.');
    }
    const parsedTime = readTime(reminderTime);
    if (reminderEnabled && !parsedTime.ok) return setErrorText(parsedTime.message);
    const result = await onSubmit({
      kind,
      title: submittedTitle,
      amountMinor: amount.minor,
      dueDate: parsedDue === null ? undefined : parsedDue.date,
      reminderEnabled: reminderEnabled && parsedDue !== null,
      reminderTime:
        reminderEnabled && parsedDue !== null && parsedTime.ok ? parsedTime.time : undefined,
      // Untouched optional text is passed EXACTLY as stored (no trim, no rewrite).
      note: submittedOptionalText(note, noteTouched, initial?.note),
    });
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title={mode === 'create' ? 'Новое обязательство' : 'Изменить обязательство'}
      subtitle="Обязательства не меняют баланс. Отметка «выполнено» — только статус."
      primaryLabel="Сохранить"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <AppText variant="label">Тип</AppText>
      <Choice
        options={(['payment', 'debt', 'receivable', 'purchase'] as const).map((value) => ({
          value,
          label: OBLIGATION_KIND_LABELS[value],
        }))}
        value={kind}
        onChange={setKind}
      />
      <TextField
        label="Название"
        value={title}
        onChange={(value) => {
          setTitleTouched(true);
          setTitle(value);
        }}
        placeholder="Аренда"
      />
      <MoneyField label="Сумма" value={amountText} onChange={setAmountText} currency={currency} />
      <TextField
        label="Срок (необязательно, ГГГГ-ММ-ДД)"
        value={dueDate}
        onChange={setDueDate}
        placeholder="2026-10-01"
      />
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: reminderEnabled }}
        onPress={() => setReminderEnabled((current) => !current)}
        style={styles.switchRow}
      >
        <AppText variant="label">Напоминание</AppText>
        <AppText variant="label" color={reminderEnabled ? 'success' : 'muted'}>
          {reminderEnabled ? 'Вкл' : 'Выкл'}
        </AppText>
      </Pressable>
      {reminderEnabled ? (
        <>
          <TextField label="Время (ЧЧ:ММ)" value={reminderTime} onChange={setReminderTime} />
          <AppText variant="meta" color="muted">
            На экране блокировки будет видно название. Планирование уведомлений появится позже
            (Slice 6B) — сейчас сохраняется только намерение.
          </AppText>
        </>
      ) : null}
      <TextField
        label="Заметка (необязательно)"
        value={note}
        onChange={(value) => {
          setNoteTouched(true);
          setNote(value);
        }}
        multiline
      />
    </FinanceSheetShell>
  );
}

export function FinanceBalanceSheet({
  currency,
  currentMinor,
  busy,
  onCancel,
  onSubmit,
}: {
  currency: FinanceCurrency;
  currentMinor: number;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (balanceMinor: number) => Promise<SheetOutcome>;
}) {
  const [value, setValue] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const parsed = parseMoneyToMinorForSheet(value);
  const delta = parsed.ok ? parsed.minor - currentMinor : null;

  async function submit() {
    setErrorText(null);
    const amount = readMoney(value, 'Баланс');
    if (!amount.ok) return setErrorText(amount.message);
    const result = await onSubmit(amount.minor);
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title="Коррекция баланса"
      subtitle="Баланс заменяется напрямую и не учитывается в расходах/доходах. Отрицательное значение разрешено."
      primaryLabel="Применить"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <AppText variant="meta" color="muted">
        Сейчас: {formatMoneyMinor(currentMinor, currency)}
      </AppText>
      <MoneyField
        label="Новый баланс"
        value={value}
        onChange={setValue}
        currency={currency}
        allowNegative
      />
      {delta === null ? null : (
        <AppText variant="meta" color={delta === 0 ? 'muted' : 'secondary'}>
          Будет: {formatMoneyMinor(currentMinor + delta, currency)} · изменение{' '}
          {formatMoneyMinor(delta, currency)}
        </AppText>
      )}
    </FinanceSheetShell>
  );
}

export function FinanceLimitSheet({
  currency,
  beforeMinor,
  autoPreviewMinor,
  manualMinor,
  busy,
  onCancel,
  onSubmit,
}: {
  currency: FinanceCurrency;
  /** null when today's allowance does not exist yet (an explicit action creates it). */
  beforeMinor: number | null;
  /** Current AUTO recalculation (from the present balance and future horizon). */
  autoPreviewMinor: number | null;
  manualMinor: number | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    mode: FinanceLimitMode;
    manualLimitMinor: number | null;
  }) => Promise<SheetOutcome>;
}) {
  const [mode, setMode] = useState<FinanceLimitMode>(manualMinor === null ? 'auto' : 'manual');
  const [value, setValue] = useState(
    manualMinor === null ? '' : formatMoneyInput(manualMinor),
  );
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    setErrorText(null);
    if (mode === 'auto') {
      if (autoPreviewMinor === null) {
        return setErrorText(
          'Нет горизонта: укажите дату следующего дохода или ручной лимит.',
        );
      }
      const result = await onSubmit({ mode: 'auto', manualLimitMinor: null });
      if (!result.ok) setErrorText(result.message);
      return;
    }
    const amount = readMoney(value, 'Лимит');
    if (!amount.ok) return setErrorText(amount.message);
    if (amount.minor < 0) return setErrorText('Лимит не может быть отрицательным.');
    const result = await onSubmit({ mode: 'manual', manualLimitMinor: amount.minor });
    if (!result.ok) setErrorText(result.message);
  }

  const manualTyped = readMoney(value, 'Лимит');
  const after =
    mode === 'auto' ? autoPreviewMinor : manualTyped.ok ? manualTyped.minor : null;

  return (
    <FinanceSheetShell
      title="Изменить лимит на сегодня"
      subtitle="Меняется только сегодняшний лимит. Расходы не изменяются, превышение пересчитывается."
      primaryLabel="Применить"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <AppText variant="meta" color="muted">
        {beforeMinor === null
          ? 'Лимит на сегодня ещё не зафиксирован — это действие его создаст.'
          : `Сейчас: ${formatMoneyMinor(beforeMinor, currency)}`}
      </AppText>
      <Choice
        options={[
          { value: 'auto', label: LIMIT_MODE_LABELS.auto },
          { value: 'manual', label: LIMIT_MODE_LABELS.manual },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === 'manual' ? (
        <MoneyField label="Новый лимит" value={value} onChange={setValue} currency={currency} />
      ) : (
        <AppText variant="meta" color="muted">
          Авто пересчитает лимит из текущего баланса и горизонта дохода на сегодня.
        </AppText>
      )}
      {after === null ? null : (
        <AppText variant="meta" color="secondary">
          Будет: {formatMoneyMinor(after, currency)}
        </AppText>
      )}
    </FinanceSheetShell>
  );
}

export function FinanceExpectationSheet({
  mode,
  initialKind = 'oneTime',
  initial,
  currency,
  today,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initialKind?: 'monthly' | 'oneTime';
  initial?: {
    title?: string;
    amountText?: string;
    date?: string;
    dayOfMonth?: number;
    active?: boolean;
  };
  currency: FinanceCurrency;
  today: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (
    input:
      | { kind: 'monthly'; draft: ScheduleDraft }
      | { kind: 'oneTime'; draft: ExpectationDraft },
  ) => Promise<SheetOutcome>;
}) {
  const [kind, setKind] = useState<'monthly' | 'oneTime'>(initialKind);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [titleTouched, setTitleTouched] = useState(false);
  const [amountText, setAmountText] = useState(initial?.amountText ?? '');
  const [amountTouched, setAmountTouched] = useState(false);
  const [dateTouched, setDateTouched] = useState(initial?.date !== undefined);
  const [dateValue, setDateValue] = useState(initial?.date ?? '');
  const [dayOfMonth, setDayOfMonth] = useState(String(initial?.dayOfMonth ?? 25));
  const [active, setActive] = useState(initial?.active ?? true);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    setErrorText(null);
    const submittedTitle = submittedText(title, titleTouched);
    if (submittedTitle.trim().length === 0) return setErrorText('Укажите название ожидания.');
    const amount = readMoney(amountText, 'Сумма');
    if (!amount.ok) return setErrorText(amount.message);
    const originalAmount = parseMoneyToMinor(initial?.amountText ?? '');
    const preservedZero = mode === 'edit' && kind === 'monthly' && !amountTouched && originalAmount.ok && originalAmount.amountMinor === 0 && amount.minor === 0;
    if (amount.minor <= 0 && !preservedZero) return setErrorText('Ожидаемая сумма должна быть больше нуля.');
    if (kind === 'monthly') {
      const day = Number(dayOfMonth.trim());
      if (!Number.isSafeInteger(day) || day < 1 || day > 31) {
        return setErrorText('День месяца: число от 1 до 31.');
      }
      const result = await onSubmit({
        kind: 'monthly',
        draft: {
          dayOfMonth: day,
          expectedAmountMinor: amount.minor,
          amountChanged: amountTouched,
          title: submittedTitle,
          active,
        },
      });
      if (!result.ok) setErrorText(result.message);
      return;
    }
    // Resolve and validate against the same submit-time local date.
    const submittedToday = localDateIso(new Date());
    const parsedDate = readDate(
      resolveSubmittedFinanceDate({
        originalDefaultDate: today,
        currentDraftDate: dateValue,
        wasDateTouched: dateTouched,
        nowLocalDate: submittedToday,
      }),
      'Дата',
    );
    if (!parsedDate.ok) return setErrorText(parsedDate.message);
    const result = await onSubmit({
      kind: 'oneTime',
      draft: { date: parsedDate.date, amountMinor: amount.minor, title: submittedTitle },
    });
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title={mode === 'create' ? 'Ожидаемый доход' : 'Изменить ожидание'}
      subtitle="Ожидаемый доход не меняет баланс. Получение оформляется отдельно кнопкой «Получено»."
      primaryLabel="Сохранить"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      {mode === 'edit' ? null : (
        <>
          <AppText variant="label">Тип ожидания</AppText>
          <Choice
            options={[
              { value: 'monthly', label: 'Каждый месяц' },
              { value: 'oneTime', label: 'Разовое' },
            ]}
            value={kind}
            onChange={setKind}
          />
        </>
      )}
      <TextField
        label="Название"
        value={title}
        onChange={(value) => {
          setTitleTouched(true);
          setTitle(value);
        }}
        placeholder="Зарплата"
      />
      <MoneyField
        label="Ожидаемая сумма"
        value={amountText}
        onChange={(value) => { setAmountTouched(true); setAmountText(value); }}
        currency={currency}
      />
      {kind === 'monthly' ? (
        <>
          <TextField label="День месяца (1–31)" value={dayOfMonth} onChange={setDayOfMonth} />
          <AppText variant="meta" color="muted">
            29–31 в коротком месяце сдвигаются на последний день месяца.
          </AppText>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: active }}
            onPress={() => setActive((current) => !current)}
            style={styles.switchRow}
          >
            <AppText variant="label">Ожидание активно</AppText>
            <AppText variant="label" color={active ? 'success' : 'muted'}>
              {active ? 'Да' : 'Нет'}
            </AppText>
          </Pressable>
        </>
      ) : (
        <TextField
          label="Дата (ГГГГ-ММ-ДД)"
          value={dateTouched ? dateValue : today}
          onChange={(value) => {
            setDateTouched(true);
            setDateValue(value);
          }}
          placeholder={today}
        />
      )}
    </FinanceSheetShell>
  );
}

export function FinanceReceiveSheet({
  currency,
  today,
  title,
  expectedText,
  busy,
  onCancel,
  onSubmit,
}: {
  currency: FinanceCurrency;
  today: string;
  title: string;
  expectedText: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: Omit<ReceiveDraft, 'id'>) => Promise<SheetOutcome>;
}) {
  const [amountText, setAmountText] = useState(expectedText);
  const [dateTouched, setDateTouched] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [source, setSource] = useState(title);
  const [sourceTouched, setSourceTouched] = useState(false);
  const [note, setNote] = useState('');
  const [noteTouched, setNoteTouched] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    setErrorText(null);
    const amount = readMoney(amountText, 'Сумма');
    if (!amount.ok) return setErrorText(amount.message);
    if (amount.minor <= 0) return setErrorText('Сумма должна быть больше нуля.');
    // Resolve and validate against the same submit-time local date.
    const submittedToday = localDateIso(new Date());
    const parsedDate = readDate(
      resolveSubmittedFinanceDate({
        originalDefaultDate: today,
        currentDraftDate: dateValue,
        wasDateTouched: dateTouched,
        nowLocalDate: submittedToday,
      }),
      'Дата',
    );
    if (!parsedDate.ok) return setErrorText(parsedDate.message);
    if (parsedDate.date > submittedToday) return setErrorText('Дата не может быть в будущем.');
    const result = await onSubmit({
      amountMinor: amount.minor,
      date: parsedDate.date,
      source: submittedOptionalText(source, sourceTouched),
      note: submittedOptionalText(note, noteTouched),
    });
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title="Получено"
      subtitle="Доход и отметка о получении сохраняются одним действием. Баланс изменится один раз."
      primaryLabel="Получено"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <MoneyField label="Сумма" value={amountText} onChange={setAmountText} currency={currency} />
      <TextField
        label="Дата (ГГГГ-ММ-ДД)"
        value={dateTouched ? dateValue : today}
        onChange={(value) => {
          setDateTouched(true);
          setDateValue(value);
        }}
        placeholder={today}
      />
      <TextField
        label="Источник"
        value={source}
        onChange={(value) => {
          setSourceTouched(true);
          setSource(value);
        }}
      />
      <TextField
        label="Заметка (необязательно)"
        value={note}
        onChange={(value) => {
          setNoteTouched(true);
          setNote(value);
        }}
        multiline
      />
    </FinanceSheetShell>
  );
}

/**
 * Permanent limit settings after setup: the mode/manual amount/fallback horizon for
 * FUTURE days, with a separate explicit choice to apply the same choice to today.
 */
export function FinanceLimitSettingsSheet({
  currency,
  limitMode,
  manualMinor,
  fallbackEndDate,
  autoPreviewMinor,
  todayHasAllowance,
  busy,
  onCancel,
  onSubmit,
}: {
  currency: FinanceCurrency;
  limitMode: FinanceLimitMode;
  manualMinor: number | null;
  fallbackEndDate: string | null;
  autoPreviewMinor: number | null;
  todayHasAllowance: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    limitMode: FinanceLimitMode;
    manualLimitMinor: number | null;
    fallbackEndDate: string | null;
    applyToday: boolean;
  }) => Promise<SheetOutcome>;
}) {
  const [mode, setMode] = useState<FinanceLimitMode>(limitMode);
  const [value, setValue] = useState(manualMinor === null ? '' : formatMoneyInput(manualMinor));
  const [fallback, setFallback] = useState(fallbackEndDate ?? '');
  const [applyToday, setApplyToday] = useState(!todayHasAllowance);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    setErrorText(null);
    let manualLimitMinor: number | null = null;
    if (mode === 'manual') {
      const amount = readMoney(value, 'Лимит');
      if (!amount.ok) return setErrorText(amount.message);
      if (amount.minor < 0) return setErrorText('Лимит не может быть отрицательным.');
      manualLimitMinor = amount.minor;
    }
    const trimmedFallback = fallback.trim();
    const parsedFallback =
      trimmedFallback.length === 0 ? null : readDate(trimmedFallback, 'Дата дохода');
    if (parsedFallback !== null && !parsedFallback.ok) return setErrorText(parsedFallback.message);
    if (applyToday && mode === 'auto' && autoPreviewMinor === null) {
      return setErrorText('Нет горизонта: укажите дату следующего дохода или ручной лимит.');
    }
    const result = await onSubmit({
      limitMode: mode,
      manualLimitMinor,
      fallbackEndDate: parsedFallback === null ? null : parsedFallback.date,
      applyToday,
    });
    if (!result.ok) setErrorText(result.message);
  }

  return (
    <FinanceSheetShell
      title="Лимит и режим"
      subtitle="Настройки действуют на будущие дни. Существующий лимит на сегодня не меняется без явного выбора."
      primaryLabel="Сохранить"
      busy={busy}
      errorText={errorText}
      onClose={onCancel}
      onPrimary={() => void submit()}
    >
      <Choice
        options={
          [
            { value: 'auto', label: LIMIT_MODE_LABELS.auto },
            { value: 'manual', label: LIMIT_MODE_LABELS.manual },
          ] as const
        }
        value={mode}
        onChange={setMode}
      />
      {mode === 'manual' ? (
        <MoneyField label="Сумма в день" value={value} onChange={setValue} currency={currency} />
      ) : (
        <AppText variant="meta" color="muted">
          Авто: лимит дня = баланс ÷ дней до ближайшего ожидаемого дохода. Если дохода нет —
          укажите дату ниже.
        </AppText>
      )}
      <TextField
        label="Дата следующего дохода (ГГГГ-ММ-ДД, для авто)"
        value={fallback}
        onChange={setFallback}
        placeholder="2026-10-01"
      />
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: applyToday }}
        onPress={() => setApplyToday((current) => !current)}
        style={styles.switchRow}
      >
        <AppText variant="label">Применить к сегодняшнему лимиту</AppText>
        <AppText variant="label" color={applyToday ? 'success' : 'muted'}>
          {applyToday ? 'Да' : 'Нет'}
        </AppText>
      </Pressable>
      <AppText variant="meta" color="muted">
        {todayHasAllowance
          ? 'Если выбрать «Нет», сегодняшний сохранённый лимит останется прежним.'
          : 'Сегодняшний лимит ещё не зафиксирован — «Да» создаст его сразу.'}
      </AppText>
    </FinanceSheetShell>
  );
}

/** Minor units -> editable text (e.g. 50000 -> "500,00"). */
export function formatMoneyInput(minor: number): string {
  return formatMoneyMinor(minor, 'UAH').replace(' ₴', '');
}

function parseMoneyToMinorForSheet(
  value: string,
): { ok: true; minor: number } | { ok: false } {
  const parsed = parseMoneyToMinor(value);
  if (!parsed.ok) return { ok: false };
  return { ok: true, minor: parsed.amountMinor };
}

const styles = StyleSheet.create({
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.segment,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceSelected: { backgroundColor: colors.surfaceSelected, borderColor: colors.borderStrong },
  inlineButton: { minHeight: 40, justifyContent: 'center' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
    borderRadius: radius.item,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
  },
});
