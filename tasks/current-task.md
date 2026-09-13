# Slice 6 — Finance: product and architecture brief

Prepared 2026-09-12. **Architecture only; Finance is NOT implemented by this task.** This brief replaces the completed Slice 5 implementation brief. Slice 5 review ended REVIEW_OK; native acceptance remains pending. The reviewed mobile baseline has 362 tests (223 Slices 1–4 + 139 media). Those are prior verification results, not new Finance results.

The user authorizes a broader, bounded Finance product and this document only. Do not change MASTER_PROMPT.md, tasks/mobile-migration.md, mobile production code or existing web/backend contracts during preparation. A later implementation task executes this brief, implements Slice 6 only and stops before Slice 7.

## 1. Existing implementation audit and compatibility boundary

| Evidence | Existing behavior | Native decision |
| --- | --- | --- |
| `lib/types.ts:98–135` | SalarySchedule: id, dayOfMonth, amount, title, createdAt, updatedAt. FinanceExpense: id, date, amount, optional note, createdAt. FinanceObligation: debt/purchase, title, amount, optional dueDate/reminderTime, completed, timestamps. FinanceState: balance, salarySchedules, expenses, obligations, optional updatedAt. Amounts are major-unit numbers; no currency setting or income transactions. | Preserve named concepts and identifiers in explicit native equivalents; add income and optional metadata without reinterpreting debt as receivable. Do not change root types. |
| `app/finance-screen.tsx` | Budget/obligations sections; hardcoded UAH; balance adjustment, expense add/delete, monthly salary add/delete, obligation add/toggle/delete and month grid. No expense editing or actual income receipt. Salary calendar rows are expectations, not deposits. Completing an obligation does not change balance. | One Finance tab with Overview / Operations / Obligations; actual income separate from expected income; retain status-only completion semantics. |
| `app/finance-screen.tsx` + `lib/finance.ts` | Expense subtracts from balance, clamps at zero; deletion refunds the whole amount. `dailyBudget(balance,nextDate,today)` is recomputed from that changed balance. This violates the fixed-allowance product rule and can inflate balance after deleting a previously clamped expense. | Do not copy these defects. Signed balance, exact integer arithmetic, explicit operation deltas, separately persisted daily allowance. |
| `lib/finance.ts` | Next salary strictly after today, current/next month, monthly day clamps to month end; zero salary amounts allowed. `daysUntil` rounds elapsed milliseconds; constructors have JS years 0–99 pitfalls. Normalizer drops malformed rows and substitutes empty/zero values. | Reuse monthly concept and clamp policy, not these runtime helpers. Strict native dates/parser; no destructive normalization. Handle expected income today explicitly. |
| `lib/planner-storage.ts` | Web localStorage `personal-planner-v1` contains optional finances inside the planner snapshot. | Not a native key and not accessible automatically from native. No browser storage dependency. |
| `lib/planner-api.ts` | Finance travels through whole-state sync; preferredFinanceState selects an entire local/server finance snapshot using content and updatedAt, not transaction merge. | Do not reuse that merge for the new native model; no cloud sync in Slice 6. |
| `app/api/v1/state/route.ts:184–235,248–281` | GET reads D1 settings key `planner-finance-state`. PUT parses known finance fields and upserts JSON; omitted finances leaves it unchanged. Enum only debt/purchase; nonnegative balance; title/note limits; additional native fields are not preserved by this parser. | A V1 native envelope is NOT round-trip compatible with this API. Never send it to the old endpoint or strip fields to make it fit. Future sync requires version negotiation and explicit migration. |
| `lib/reminder-scheduler.ts` and reminder routes/Telegram delivery | Existing obligation reminder uses due date, reminder time or default 09:00; skips completed. Web delivery text assumes UAH and debt/purchase. Existing tests include Kyiv wall-clock conversion and server-state access. | Reuse due-date meaning and 09:00 default only. Native device-zone local scheduling; no server reminder routes or Telegram import. |
| `tests/finance.test.mjs` | Five tests cover helper budget division, month-end salary clamp, permissive normalization and source wiring. They do not protect fixed allowance through expense CRUD. | Keep root tests unchanged; new native production-path tests must prove that invariant. |
| `mobile/src/features/finance/FinanceScreen.tsx` | Shell only. No native Finance domain/store/storage version exists. | First native Finance schema is V1; do not invent a prior installed native Finance migration. |
| Native Calendar notification modules and lifecycle | Root-mounted lifecycle; permission/read/retry flow; latest-revision reconciliation; persisted registry; native pending-list verification; deterministic Calendar namespace; total pending policy 48 including unrelated requests; DST gap/fold handling. | Reuse contracts/policies via narrow extraction and a shared OS queue, not two racing standalone schedulers. Preserve Calendar IDs, storage and user-visible reminder semantics. |

Also inspected MASTER_PROMPT.md, AGENTS.mobile.md, MOBILE_ARCHITECTURE.md, DESIGN_SYSTEM.md, tasks/mobile-migration.md and mobile/MIGRATION_STATUS.md. Architecture examples in older documents are illustrative: current native local storage and notification implementations are the concrete baseline. Finance requires no backend credentials or external service.

## 2. Product decisions and explicit exclusions

Finance answers four questions: **what is available, today's fixed limit, today's expenses, and what comes next?** It is a personal planner with money tracking, not a bank or accounting package.

- One primary currency for the complete Finance dataset: UAH, USD, EUR or PLN, all two decimal places. First Finance setup asks currency (UAH suggested), current balance and limit mode. Setup stays inside Finance; no Settings tab/Slice 7 expansion.
- Available means the user's tracked current balance, including recorded receipts/expenses and explicit balance corrections. It excludes expected income, receivables and planned obligations. Label “Доступно” with help “По вашим записям; будущие платежи не вычтены”. No claim that this is a bank balance or financial recommendation.
- Expenses may make balance negative. Show the deficit honestly; never clamp or discard it. Expected income never increases available money automatically.
- Daily limit mode is AUTO or MANUAL; today's saved allowance is independent of subsequent transaction changes. Exact policy below.
- Keep `SalarySchedule` internally as monthly expected income, present “Доходы”, “Регулярный доход” and user-supplied titles. Salary, advance, freelance, scholarship/benefit, side income and other are optional labels, not separate accounting systems. Add one-time expectations and actual income entries.
- Optional expense category: food, transport, home, health, entertainment, shopping, other. Absence is distinct from “other”. No mandatory category or category setup screen. Income has an optional source label instead.
- Obligations: payment, debt I owe, money owed to me, planned purchase. Totals by direction/type; never subtract receivables from what the user owes to present a misleading net number.
- No bank/Monobank integration, card/account sync, multiple wallets, FX, investments, taxes, accounting ledger, budgets by category, shared/family accounts, complex reports, upload, cloud Finance sync, Telegram, push backend, subscription billing engine, debt interest, partial repayments, recurring obligation generation or import/export UI in Slice 6.
- Monthly expected-income repetition plus one-time expectations is sufficient for v1. Weekly/biweekly rules are deferred; users may enter one-time dates. No automatic posting, automatic payment or income reminder in this slice.

## 3. Exact native domain model

Use `mobile/src/types/finance.ts`; no imports from root web runtime. The following is the persisted native contract, not the old API DTO. Optional means absent, not null, unless null is explicitly shown. All collections are immutable after publication.

```ts
type CurrencyCode = 'UAH' | 'USD' | 'EUR' | 'PLN';
type IncomeSource = 'salary' | 'advance' | 'freelance' | 'benefit' | 'side' | 'other';
type ExpenseCategory = 'food' | 'transport' | 'home' | 'health' | 'entertainment' | 'shopping' | 'other';
type LocalDate = string; // strictly valid Gregorian YYYY-MM-DD, 0001–9999
type Instant = string;   // canonical UTC ISO timestamp using existing native policy
type Minor = number;     // safe integer minor units; no binary floating point money math

type SalarySchedule = {
  id: string; title: string; dayOfMonth: number; amountMinor: Minor;
  source?: IncomeSource; active: boolean;
  createdAt: Instant; updatedAt: Instant;
};
type PlannedIncome = {
  id: string; title: string; date: LocalDate; amountMinor: Minor;
  source?: IncomeSource; createdAt: Instant; updatedAt: Instant;
};
type IncomeExpectationRef =
  | { kind: 'monthly'; scheduleId: string; date: LocalDate }
  | { kind: 'once'; plannedIncomeId: string; date: LocalDate };
type IncomeResolution = {
  ref: IncomeExpectationRef; state: 'received' | 'skipped';
  incomeId?: string; // present iff received; points to one existing FinanceIncome
};
type FinanceExpense = {
  id: string; date: LocalDate; amountMinor: Minor; note?: string;
  category?: ExpenseCategory; createdAt: Instant; updatedAt?: Instant;
  balancePolicy: 'applied' | 'legacy-history';
};
type FinanceIncome = {
  id: string; date: LocalDate; amountMinor: Minor; note?: string;
  source?: IncomeSource; createdAt: Instant; updatedAt: Instant;
  expectation?: IncomeExpectationRef;
};
type FinanceObligation = {
  id: string; kind: 'debt' | 'purchase' | 'payment' | 'receivable';
  title: string; amountMinor: Minor; dueDate?: LocalDate;
  reminderTime?: string; // HH:mm; absence = reminders off; requires dueDate
  completed: boolean; createdAt: Instant; updatedAt: Instant;
};
type DailyAllowance = {
  date: LocalDate; revision: number; mode: 'auto' | 'manual'; amountMinor: Minor;
  capturedAt: Instant; baseBalanceMinor: Minor;
  horizonDate?: LocalDate; dayCount?: number; // required only in auto mode
  reason: 'day-open' | 'explicit-change';
};
type FinanceState = {
  currency: CurrencyCode;
  balanceMinor: Minor; balanceUpdatedAt: Instant;
  limit: { mode: 'auto' | 'manual'; manualMinor: Minor; fallbackEndDate?: LocalDate };
  salarySchedules: SalarySchedule[]; plannedIncomes: PlannedIncome[];
  expenses: FinanceExpense[]; incomes: FinanceIncome[];
  incomeResolutions: IncomeResolution[];
  obligations: FinanceObligation[]; allowances: DailyAllowance[];
  updatedAt: Instant;
};
type FinanceEnvelopeV1 = {
  version: 1; initialized: boolean; state: FinanceState; savedAt: Instant;
};
```

Empty initialized=false state has UAH, zero balance/manualMinor, auto mode and empty arrays; first setup commits initialized=true atomically. Empty defaults are created only for an absent key, not corrupt bytes. Fresh IDs use the existing native UUID facility. Require uniqueness within each entity collection (matching the legacy contract), not across different legacy collections. Legacy IDs are retained; reference keys and mixed-list React keys include entity type plus ID, so a salary and expense sharing an old ID cannot collide. Resolution uniqueness is by monthly scheduleId+date or once plannedIncomeId; one-time date changes update the reference only while unresolved. IDs are stable through edits.

Constraints: safe integers, absolute money and every checked aggregate <= Number.MAX_SAFE_INTEGER; amounts for operations/obligations >0; expected amounts >=0 (legacy zero preserved, but zero expectations do not form AUTO horizon); manual limit >=0. Reject overflow before writes. Parse input decimal strings (comma or dot decimal, max two fractional digits, no exponent/Infinity); convert with integer arithmetic. Reject extra decimals rather than round new entries. Never perform arithmetic on formatted strings. Selected currencies have minor scale 100; no floating-point exchange conversion.

Titles required for expectations/obligations. New/changed titles <=200 characters; notes <=2,000. Hydration/migration must preserve valid legacy longer text; use per-field changed flags, do not apply form caps to untouched legacy values. Preserve whitespace/optional presence in stored imported text; trim only newly edited values. Date/time and unknown enum/key failures are explicit; do not silently map an unknown kind to debt/other.

Currency belongs to Finance state, not every row. It may change only before data exists (zero balance, all entity/resolution/allowance arrays empty). After first saved data it is locked; explain that changing symbols would relabel history, not convert money. No reset/delete-all escape hatch in this slice. Future currency migration requires a separate decision.

## 4. Balance and operation semantics

The stored balance is authoritative, not recomputed by summing incomplete historical data. Record each effect in the same Finance write as its operation. This is deliberately not an accounting ledger.

| Action | Atomic balance effect |
| --- | --- |
| Add new expense | subtract full amount, even if it becomes negative |
| Add actual income | add amount; expected income alone has no effect |
| Edit applied expense | add old amount, subtract new amount |
| Delete applied expense | add its amount back |
| Edit actual income | subtract old amount, add new amount |
| Delete actual income | subtract its amount; signed result allowed |
| Date/note/category/source-only edit | zero balance effect |
| Legacy-history expense edit/delete | zero balance effect; historical record only |
| Set current balance | explicit replacement, never represented as income or expense |
| Add/edit/complete/reopen/delete obligation or expectation | zero balance effect |

Operations are actual events: date <= current local today at acceptance. Reject future actual entries; offer expected income or obligation instead. Backdated actual additions affect current balance immediately, and their own date's expense total; explain this before saving a historical addition. Do not rebuild past allowance snapshots. Editing/deleting old applied operations also adjusts today's tracked balance by the displayed delta; confirmation shows it. Changing expense into income is not an edit: cancel/delete then create with explicit effects.

Balance correction shows old/new/delta and commits atomically; it is excluded from spent/income statistics. Later edits of applied operations still use the delta table, not a recomputation from zero. No silent refund from a legacy expense whose original balance impact is unknowable.

## 5. Fixed daily-limit semantics

### Day establishment and horizon

Every Finance focus/foreground refresh and every Finance command samples an injected local clock. Before the first domain mutation on a local date D, ensure that date's allowance is established from the PRE-mutation committed state. Establish it in the same transaction when there is a mutation; a read-only day-open writes its own snapshot before showing the limit as saved. Domain money commands require initialized=true; setup is the only mutation accepted before that. Write failure means “Лимит не сохранён — повторить”, not a fake fixed value. Once saved, expenses, income, balance changes, schedule changes and obligation changes never rewrite it automatically.

MANUAL: snapshot amount = limit.manualMinor. AUTO: determine earliest unresolved positive expected income date strictly AFTER D, considering active monthly schedules and one-time expectations. Day-of-month 29/30/31 clamps to the real month end. Multiple expectations on the earliest date give one horizon; future expected amounts are NOT added to the numerator. Resolve/skip markers exclude that occurrence. Past expectations remain visible as overdue but do not become an imaginary future deposit. Today's unresolved expected income is shown as “Ожидается сегодня” and does not form a zero-day divisor.

If no later income exists, use explicitly configured fallbackEndDate, which must be >D. Do not silently assume a 30-day month. If no usable horizon exists, show “Укажите дату следующего дохода или ручной лимит”; limit is unavailable (no allowance row yet), while expenses and balance remain usable. Once a usable setting is supplied, create the missing snapshot from that command's post-setting state before any subsequent money operation. An existing snapshot is never replaced through this exception.

For AUTO:

- N = Gregorian calendar-day difference horizonDate − D, not elapsed milliseconds / 24h.
- Coverage is [D, horizonDate), i.e. today is included and income day excluded.
- allowanceMinor = floor(max(0, preMutationBalanceMinor) / N).
- Persist D, mode, value, base balance, horizon, N and capturedAt. Discard no fractional cents into another day automatically.

The allowance is fixed **for that date**, not forever for the whole pay period. Tomorrow derives a new snapshot from then-current balance and remaining calendar days. Explain this in mode help. No carry-over field and no automatic compensation today for overspending yesterday. This is a budgeting aid, not a guarantee of solvency.

### Today's display and explicit changes

spent(D) = sum of ALL recorded expenses dated D, including legacy history, without subtracting income. remaining(D) = savedAllowance(D) − spent(D). Never clamp remaining: show “Превышение 120 ₴” for −120. Current available balance and daily remainder are separate values.

Examples (UAH):

- At day-open balance 12,800 and horizon 10 calendar days away: AUTO=1,280.00. Expense 350 => balance 12,450, spent 350, same limit 1,280, remaining 930.
- MANUAL=500, available now 12,450, spent today 350 => remaining 150. If spent becomes 620, limit stays 500 and overspend is 120.
- AUTO 15,000 over 6 days => 2,500. Expense 3,000 => balance 12,000; today still 2,500, overspend 500. Next day: 12,000/5=2,400 if nothing else changed.
- AUTO 10.00 over 3 days => 3.33, not 3.34. Negative balance => limit 0 with visible deficit.
- Actual income 5,000 later today increases available; it does not rewrite today's snapshot. Income is not a refund that reduces spent today.

Changing mode/manual amount/fallback horizon defaults to future days. Provide a separate explicit “Изменить лимит на сегодня” action with before/after, explanation and confirmation. In AUTO it recalculates from current balance and current future horizon; in MANUAL uses proposed amount. It updates today's row with revision+1/reason=explicit-change in the same write as any settings change. Expenses remain untouched and overspend is recalculated against the expressly changed value. No automatic prompt after every expense.

Store at most one latest allowance row per date; revision identifies an explicit replacement. Past dates are read-only. Returning to a date after timezone/clock changes reuses its saved snapshot, never duplicates it. No synthetic historical snapshots for days the app was not opened; selected-day history says “Лимит не зафиксирован” when absent. On overnight form save, sample the current date again and establish the new day's allowance; keep an explicitly chosen transaction date. A default “today” date must be refreshed or shown for confirmation if the day changed while editing.

## 6. Expected and actual income

Monthly SalarySchedule stays recognizable and backward-mappable: dayOfMonth, title, expected amount and timestamps remain. Native source/active metadata is additive; major-to-minor storage conversion is explicit. Several schedules support salary plus advance; identical dates are allowed, duplicate IDs are not. Editing a schedule affects future/unresolved expectations, not recorded income or past allowance values. Deleting/pausing a schedule never deletes receipts. Retain resolution refs as historical identifiers even when a schedule was deleted; do not regenerate a deleted schedule from receipts.

PlannedIncome represents one future/overdue expectation; FinanceIncome represents an actual receipt. From an expectation, “Получено” opens the income form with editable amount/date/source and commits income+received resolution+balance in ONE write. Stable occurrence key prevents duplicate receipt on rapid taps/retry. No payment is assumed from crossing midnight or reopening the app. “Пропустить” resolves an expectation without balance effect. Reopening a skipped occurrence removes that marker; received occurrences must be changed through their linked income, not posted twice.

Deleting a linked income reverses its amount and removes its received marker, making the expectation unresolved if its source still exists. Editing its receipt amount/date does not change the original expected occurrence key. A skipped occurrence can later be received by replacing its marker atomically. A one-time expectation with a linked receipt is read-only except its descriptive title; delete expectation only retains the receipt and its historical reference. Monthly recurrence generation is bounded to requested month/nearest-next lookup, not materialized for thousands of years.

## 7. Obligations and reminders UX

| Stored kind | Label | Examples | Balance effect |
| --- | --- | --- | --- |
| payment | Платёж | rent, utilities, credit payment | none until separate actual expense |
| debt | Я должен | debt to friend | none until separate actual expense |
| receivable | Мне должны | friend owes user | none until separate actual income |
| purchase | Покупка | phone, laptop | none until separate actual expense |

Amount and title required; due date and reminder optional. Reminder toggle is OFF for new items; enabling requires dueDate and a time, suggested 09:00 on that due date. One local notification per obligation, no advance reminder or repeating nag. Removing due date explicitly turns reminder off. Overdue items remain visible; do not fire an immediate historical notification. Reminder denial does not erase due date or intent.

Completion/reopen is status-only (“Отметить выполненным”, help: “Баланс не изменится”). Do not label the action as executing a payment. Actual expense/income remains a separate user action in Operations, avoiding an implicit double debit/credit. No hidden link, partial settlement or interest calculation. Completing or deleting cancels the reminder after metadata commits; reopening schedules only a still-future configured reminder. Editing due date/time/title reschedules and verifies current content. Completed history remains accessible; delete requires identity/revision-aware confirmation and never changes balance.

## 8. Persistence, migration and preservation

Storage key: `workazy-native-finance-v1`, envelope version 1. Use AsyncStorage behind an injected port as in existing native stores. Separate OS registry key `workazy-native-finance-notifications-v1` stores `{version:1,records,savedAt}`; records use the Calendar registry lifecycle/status contract with obligationId and kind='due'. A registry failure is a reminder failure, never a rollback of a successfully saved financial operation.

Strict parse before publish AND before every write: validate full envelope, finite safe integer amounts and aggregates, enums, IDs/duplicates, real dates, timestamps, reference uniqueness and receipt/resolution consistency. Unknown schema version, corrupt bytes or invalid rows => load-error; retain original bytes, block writes and offer retry. Never replace with empty state or filter “bad” records out. No other feature's storage is touched. Corrupt notification registry blocks its destructive reconciliation until recovered; do not delete unknown OS notifications.

Store pattern: loading/ready/load-error, frozen snapshot wrapper and deeply frozen rows/nested refs/settings, monotonic committed revision, synchronous write gate acquired before awaits. CRUD accepts expected identity/revision and changed fields; stale/busy submissions return typed results. Build exact candidate from latest committed state, validate/serialize, await durable setItem, then publish. No optimistic balance or allowance update. Failed write leaves previous state and UI draft intact; retry uses stable intent/entity IDs. Domain mutations and registry writes cannot overwrite each other's envelopes. App termination before a write resolves is not claimed atomic/durable. Hydrate before finance reminder reconciliation.

### Legacy migration contract (no automatic web access)

No earlier native Finance key/schema was found. Do NOT read other native slices for finance or introduce an unrequested web import flow. Slice 6 should include an injected pure, tested `migrateLegacyFinanceState` adapter so existing FinanceState is understood; its runtime invocation requires a future explicitly supplied transfer source. New native users start empty. Existing web localStorage and D1 JSON remain untouched and authoritative for web; there is no automatic cross-install/browser migration.

When a transfer is separately authorized, its transaction must be:

1. Preserve exact raw source bytes in a transfer backup before any target write. Decode either FinanceState or explicitly selected `personal-planner-v1.finances`; never guess between competing snapshots. No timestamp-winner overwrite of a populated native dataset.
2. Validate all source rows first. Preserve IDs, array order, optional fields, complete text, timestamps and completed states. An absent legacy obligations collection becomes []; missing required collections, duplicates, invalid calendar dates, unsupported keys/precision/timestamps or unsafe amounts produce a report and block the whole conversion. No silent salvage. Legacy normalizer's regex-only dates/drop behavior is not the migration validator.
3. Default known web currency to UAH and state that assumption in the transfer preview. Exact two-decimal major values convert to minor units using decimal parsing of their canonical number representation; binary artifacts or >2 decimals require an explicit rounding decision and report, with original bytes retained. Do not silently round legitimate source data. Legacy zero schedule amount is retained but not a horizon candidate.
4. Legacy balance becomes balanceMinor as-is; do NOT subtract imported expenses again. Imported expenses get balancePolicy='legacy-history': they appear in history/spent totals, but editing/deleting them does not refund/debit today's balance. Explain this during transfer and in their edit/delete preview. Historical cashflow cannot be reconstructed because the web allowed balance resets and clamped overspending.
5. salarySchedules map to active monthly SalarySchedule with no fabricated source label. Existing debt=>debt owed by user; purchase=>purchase; never guess receivable/payment from text. dueDate/reminderTime and completed preserve exactly; date with absent reminder time becomes explicit 09:00 to preserve the legacy default-reminder intent, recorded as a migration change. A reminderTime without dueDate must be reported rather than silently discarded.
6. No receipts, income entries or historical allowances are invented. Preserve an existing valid FinanceState.updatedAt; if absent, use the accepted transfer instant for native state.updatedAt and balanceUpdatedAt (new bookkeeping, not a claimed historical transaction time). Set balanceUpdatedAt from legacy updatedAt when present. AUTO configuration starts without snapshots; establish today's allowance only after transfer is accepted. No notifications before successful target persistence AND a separately granted native notification permission; importing reminder intent is not consent to a new permission prompt.
7. Validate/round-trip V1, persist target once, then publish; failure retains source/backup and leaves prior target unchanged. Repeated transfer ID must be idempotent, not append duplicates. Populated target requires a later explicit merge design; refuse automatic replacement. Transfer tooling/import UI, backup transport and server format changes are outside Slice 6.

Future native V2 must retain V1 bytes until conversion succeeds, use an explicit versioned adapter and refuse unknown future versions. Native-only negative balance, new kinds, currency, income and allowance snapshots cannot be pushed to legacy web unchanged. Preserve concepts via adapters; do not advertise wire compatibility merely because type names match.

## 9. Native notification integration and cross-feature ownership

Reuse existing Calendar date conversion, trigger decoding, permission semantics, native pending verification and convergence protocol. No Telegram or server scheduling calls. Prefer small neutral helpers extracted from current modules over copying the entire reconciler or making a generic plugin framework.

- Finance namespace `workazy.finance.v1`, owner `workazy-finance-v1`, deterministic ID `workazy.finance.v1:<obligationId>:due`. Calendar namespace/owner/IDs remain exactly unchanged. Data includes owner, obligationId, kind='due', fingerprint and persisted targetTriggerAt/scheduledAt using current adapter policy. Fingerprint covers trigger, title and kind; use generic lock-screen body “Финансовое напоминание · <title>”, no amount, note or debt direction. Title is user-visible on lock screen; make that clear beside the reminder toggle.
- One process-level serial **OS reconciliation queue** shared by Calendar and Finance, including cancel/list/schedule/read-back work. Each domain retains its own store, registry and desired planner. Do not wrap only individual calls: capacity read -> decisions -> mutations -> verification must be ordered against the other domain. Domain revision changes abort stale passes; rerun from latest state. Never await a nested acquisition of this queue.
- Preserve existing total pending app policy 48, counting ALL OS pending requests, including unknown/foreign requests. Never allocate 48 per domain. On combined startup, enqueue Calendar then Finance; afterwards FIFO with coalesced per-domain requests. Within a domain use earliest trigger then stable ID. Existing valid foreign/domain requests are not evicted to prioritize another domain. This deliberately does not guarantee globally earliest-48 fairness; capacity-limited UI must say reminders remain unscheduled and will retry on foreground/tick. No claim all financial reminders fire when capacity is full.
- Each reconciler cancels only its positively owned IDs; it must never cancel the other domain or call cancelAll. Finance's ownership predicate must not recognize Calendar prefixes. Unknown inventory occupies slots. A successful schedule is verified against actual native title/body/trigger AND metadata, preserving current absolute vs iOS interval tolerance/target policy. Registry metadata alone is not proof.
- Failed list/cancel/schedule/verification/registry-write yields visible retryable notification state; finance Save may succeed while reminders need retry. Orphan/duplicate cleanup is scoped to confirmed ownership and latest committed desired state. Re-list after cancellations before allocating slots. Restart discovers actual pending inventory even if the last registry write failed.
- Reconcile after hydrated startup, committed relevant CRUD, completion/delete, foreground/focus, timezone change and the existing active-only periodic refresh. No background timer guarantee or permission prompt at startup. Reuse one foreground handler; do not overwrite it with a Finance-only handler. Shared permission request flow is single-flight; ask only from explicit “Включить уведомления” action. Denied => Settings guidance; provisional => honest quiet-delivery status. Returning from Settings refreshes both domains.
- On notification tap, route Finance-owned payloads to the existing Finance tab/obligation only after hydration and live ID check; missing/deleted target shows list. Never interpret Finance payload as Calendar event. No new inbox.

Required narrow exception to protected Calendar code: shared queue integration and neutral extraction only, retaining Calendar storage schema, IDs, start/advance semantics and existing tests. Update root lifecycle wiring only as needed for Finance hydration/notifications. Capture protected hashes before implementation; document this exception in the implementation report. Everything else in Calendar remains protected.

## 10. Dates and mobile information architecture

All financial dates are local Gregorian dates 0001–9999. Reuse proven native Calendar/Records date primitives or extract a neutral pure helper; never construct years 0–99 with `new Date(year,month,day)` or divide DST-spanning milliseconds to count days. Numeric/lexical sort is safe only after strict validation. Month/day navigation clamps and stops at range edges; no year 0000/10000 or overflow recurrence. Invalid timezone/unsupported native date-picker range produces explicit fallback text-date entry or unavailable reminder, not a remapped date.

Reminder wall-clock dates/times follow the CURRENT device timezone, as native Calendar does. Travel changes reminder instant after reconciliation, not stored date. Use existing earlier-occurrence policy for autumn folds and explicit unscheduleable warning for spring gaps; no silent shift. Past trigger => no immediate alert. Existing web Kyiv policy is source context, not a fixed native timezone. Tests inject timezone/clock.

One existing bottom tab, three internal segments: **Обзор | Операции | Обязательства**. Income settings are an Overview sheet, not a fourth segment.

- Overview: available balance (tap to explicitly correct), fixed daily limit + mode/help, spent today, remaining/overspent, Add expense / Add income, next expected income and next open due obligation. Today's pending and overdue items must remain visible before future events; stable ordering date then ID; no fake “next” when none exists. Compact collapsible month calendar below the essential content.
- Operations: mixed actual expense/income history, newest date then createdAt then ID; day filter from financial calendar, clear filter action, add/edit/delete sheets. A small type filter is sufficient; no report-builder. Expected amounts never masquerade as actual transactions.
- Obligations: open/completed toggle, grouped readable kind labels or small optional kind filter; nearest/overdue due first, undated last. No four nested tab systems. Due date is not inherently a reminder. Long titles/notes have a full readable view.
- Finance calendar is a view into Finance data only: expense/income activity, unresolved expected income and obligation due markers; selecting a day shows actual totals, separately labeled expectations/due items and saved allowance if present. No duplicate CalendarEvent creation. No forecast allowance presented as historical fact. Future day has no actual transactions and no invented daily snapshot.

Use existing tokens, native typography and 44pt targets; semantic mint for income/available/success, restrained expense styling, explicit minus and “Превышение” text rather than color-only feedback. No desktop grid/tables or giant charts. Forms keyboard-safe with persistent reachable Save/Cancel, decimal keyboard plus visible currency, accessible labels, Dynamic Type and safe areas. Empty/loading/load-error/persist-error/notification-error/capacity states are real and retryable. No demo finances seeded in production.

## 11. Implementation boundaries and acceptance criteria

Expected future files: `types/finance.ts`; `features/finance/{financeModel,financeDates,financeStore,useFinanceStore,financeSheetGuard,FinanceScreen,...}`; `storage/financeStorage.ts`; pure Finance notification planner/reconciler/registry adapter; shared OS queue; small additions to existing root lifecycle. Names may follow current conventions. Add no package unless installed native facilities are demonstrably insufficient; no new HTTP or chart dependencies.

Preserve root app/API/DB/worker/Telegram files and tests; Plans, Ideas, Journal/media/Records behavior, theme, four tabs and Calendar data contract. Only the narrow Calendar queue integration above is allowed. Before implementation record current git status, protected-file hashes and actual baseline checks; do not erase unrelated dirty changes from Slice 5.

Acceptance requires working persisted flows, not just UI:

1. First setup, signed balance, currency lock and both limit modes work offline through restart.
2. Exact example 500 limit / 620 expense visibly remains 500 / 620 / overspend 120 after CRUD, rerender, restart and clock refresh.
3. Actual income changes balance only once; expected income never auto-posts. Monthly and one-time receipts/retries are duplicate-safe.
4. Expenses/incomes support add/edit/delete with exact deltas and no loss of notes/legacy fields. Past edits do not rewrite stored historical/today allowances. Failed save leaves drafts and persisted state intact.
5. All four obligation kinds, due dates, optional reminders and completed history work; status changes never silently move money.
6. Reminder scheduling/edit/delete/complete/reopen/restart/Settings return converge without touching Calendar-owned requests or exceeding shared capacity through a race.
7. Legacy adapter preserves all accepted source data without double-applying expenses; incompatible data blocks with a report and no writes. No import or cloud sync claim.
8. Finance calendar remains a Finance projection; no duplicate main Calendar entries or new primary navigation.
9. Existing 362 baseline tests remain unchanged and pass; Finance tests exercise production-used paths. No runtime/security leakage.

## 12. Test and verification plan

Tests must call the real parser/model/store/reconciler/controller using injected storage/clock/OS ports; UI wiring receives separate inspection. Do not accept source-regex-only claims or tests of unused copies.

- Money: integer cents, comma/dot input, zero/negative boundaries, unsafe integer/aggregate overflow, >2 decimals, huge amounts, subtract below zero, exact inverse edit/delete; imported historical effect zero; explicit balance correction then old operation edit.
- Allowance: persisted pre-expense snapshot, identical value after expense/income/add/edit/delete/restart; 500/350/150 and 500/620/−120; floor cents; no horizon; fallback expiration; income today not zero divisor; midnight crossing, unopened days, timezone return, explicit mode/limit change versus next-day defaults; failed snapshot persistence and concurrent first expenses.
- Expected income: 29/30/31 clamp/leap years; multiple schedules same day; zero expectations; next year boundary; today/overdue/skipped/received; duplicate receipt rapid taps; delete receipt reopens occurrence; schedule deletion retains linked income; no automatic credit.
- Obligations: all kinds, due-less reminders refused, default off, completion does not change balance, reopen past vs future, stale confirmation after edit/delete, long untouched fields and completed history.
- Persistence/migration: absent key vs corrupt key vs future version; unknown fields/enums/duplicate IDs; deeply frozen snapshots; parse before every write; write gate held across awaits; storage rejection, retry/stable IDs, hydration and async old completion; legacy balance not recomputed; optional obligations; legacy zero schedule; precision/invalid dates report; no source deletion; authorized transfer fixture idempotency and no target overwrite.
- Notifications: two domains against ONE fake OS inventory/queue. Pause inside OS list/schedule/cancel, mutate state and enqueue other domain before releasing gate. Prove no duplicate schedule, cross-cancel, stale title/time or >48 allocation. Foreign requests, corrupt registry, cancelled-but-still-pending, successful schedule with failed registry write, process restart, denied/provisional permission, Settings return, empty/deleted target tap, capacity refill. Verify real native trigger/content rather than metadata alone.
- Dates: UTC, Europe/Kyiv, America/Los_Angeles; years 0001/0009/0099/0100/9999; reject 0000/impossible dates; DST gaps/folds; travel changes timezone; no fixed offset/current date. Existing Calendar/Records date tests remain unchanged.
- Regressions: >100k Journal text, untouched optional fields, immutable snapshots and persist-before-commit; Slice 5 files/leases/recorders/playback unchanged; all protected baseline tests pass. Scan for browser/server imports, Telegram, HTTP, credentials and binary/base64 state.

Future implementation commands: mobile `npm test`, all three TZ test runs, `npm run typecheck`, `npm run lint`, `npx eslint .`, `npx expo install --check`, `npx expo-doctor`, `npm run export:ios`; root `npm run build`; `git diff --check`; protected hashes/diff and leakage scans. Report actual results and network/tool blockers. Preserve the three existing Calendar-test ESLint warnings without adding suppressions. Unit tests/export are not native acceptance.

## 13. Proposed product-contract wording (do not edit those files now)

No primary section or existing concept is removed. These clarifications are authorized by the user's product request, but the source contracts remain unchanged in this preparation task:

- `MASTER_PROMPT.md:108`, “Salary schedule”: propose “Expected income schedules (including SalarySchedule), one-time expected income and explicitly recorded actual income.” SalarySchedule remains monthly and legacy IDs/values migrate explicitly; no API-compatible rename is asserted.
- `MASTER_PROMPT.md:112`, fixed calculated allowance sentence: propose “The daily allowance is saved for each local date in AUTO or MANUAL mode. Expenses are tracked against it and never automatically rewrite it. Only an explicit confirmed change may replace today's allowance; a new local date establishes a new allowance.” This clarifies the fixed-period boundary and adds manual mode without weakening the invariant.
- `tasks/mobile-migration.md:93–104`, Slice 6 implementation/acceptance block: propose “Implement one Finance tab with Overview, Operations and Obligations; current balance and primary currency; fixed daily allowance (AUTO/MANUAL); SalarySchedule-compatible expected income and one-time expectations; expense/income CRUD; payment/debt/receivable/purchase obligations; native local reminders. Accept only with versioned local persistence, lossless-or-blocked legacy conversion, no automatic allowance rewrite from operations, and Calendar-isolated reminder reconciliation under shared OS capacity.”

Currency selection within Finance is a necessary Finance input, not implementation of general Slice 7 Settings. Extended native kinds/amount representation require the migration/adapter defined here; root wire contracts stay unchanged. No amendment to MASTER_PROMPT or tasks/mobile-migration is made by this brief.

## 14. Native-device acceptance — PENDING until observed

All previous slices' native acceptance remains pending. Finance requires actual iPhone observation of: first setup and locale decimal keyboard; keyboard-safe forms/scrolling; notched/Dynamic Island safe areas; large Dynamic Type/VoiceOver; long text and large/negative values; local midnight/foreground/travel updates; permission prompt/denial/provisional/Settings return; obligation notification scheduling/delivery/tap/cancel/edit/reopen while Calendar reminders coexist; native trigger timing across DST; app termination/restart and storage failure/disk-full behavior. No claimed bank balance accuracy, delivery guarantee, background execution or device success from mocks/export.

Preparation deliverable is this document only. Finance implementation, source contract edits and native acceptance are not performed or claimed.
