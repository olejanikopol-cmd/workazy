# Slice 3 — Native Calendar and local notifications

Implementation brief for **DeepSeek**, prepared 2026-09-10. Implement this slice only, in one autonomous pass. This document replaces the completed Slice 2 brief; it does not authorize later migration slices.

## Objective and baseline

Build the Calendar tab's month/day workspace, local CalendarEvent CRUD and reliable iPhone local reminders. Preserve the existing domain contract and all Slice 1/2 behavior. No backend, authentication, web-data import, Telegram, server reminder tick, remote push tokens, secrets, system-calendar integration, recurrence, custom sounds, notification inbox, notification deep links, Journal, Finance, Goals, Assignments or media work.

Repository: `/Users/oleh/workazy/workazy`. The real web app remains at root `app/`, `lib/`, `db/`, `worker/`; the native app is the independent `mobile/` package. Do not regenerate its scaffold or turn the root into a workspace. Existing tracked root changes are only the mobile TypeScript exclusion and ESLint ignore; preserve them. Many harness/mobile files are untracked: record their contents as well as git status when establishing the baseline.

Observed native versions: Expo 57.0.21, Router 57.0.20, React 19.2.3, RN 0.86.3, TypeScript 6.0.3; AsyncStorage 2.2.0 and Expo Crypto already installed. Slice 2's final reported checks are 34 passing tests, including Kyiv/Los Angeles runs, typecheck/lint/iOS export and Expo checks. Re-run rather than assume. iPhone acceptance remains pending: only Xcode CommandLineTools was available. The unchanged root Telegram workflow assertion failure is pre-existing.

Navigation: exactly four tabs, Plans/Calendar/Records/Finance; `/` redirects to `/(tabs)/plans`. Never restore invalid `initialRouteName="plans"`. Plans has three reachable segments, stable Today/Tomorrow selection and durable completion/order; leave its implementation and storage key untouched.

## Read before coding — exact sources

- `AGENTS.md`, `MASTER_PROMPT.md`, `HARNESS.md`, `AGENTS.mobile.md`, `MOBILE_ARCHITECTURE.md`, `DESIGN_SYSTEM.md`, `tasks/mobile-migration.md`, this brief, `mobile/README.md`, `mobile/MIGRATION_STATUS.md`.
- `lib/types.ts`: CalendarEvent versus PlanTask/Assignment.
- `app/secondary-screens.tsx`: `CalendarScreen` (currently lines 624–681); month starts Monday, event fields/defaults and additional reminder choices.
- `app/planner-app.tsx`: Calendar state ownership, selected date and rendering; `lib/planner-data.ts`: local calendar formatting; `lib/planner-storage.ts`: web snapshot only, no native import.
- `app/api/v1/events/route.ts`, `app/api/v1/events/[id]/route.ts`, `app/api/v1/state/route.ts`: Calendar validation and serialization; `lib/planner-api.ts`: event mapping; `db/schema.ts`: event representation.
- `lib/reminder-scheduler.ts`: `parseReminderMinutes`, `calendarEventStartsAt`, `calendarEventDueAt`, calendar branch of `collectDueTelegramNotifications`; `tests/telegram-reminder.test.mjs`: event-time plus advance behavior and timezone cases. `app/api/v1/reminders/tick/route.ts` is context only, never a dependency.
- `mobile/app/_layout.tsx`, `mobile/app/index.tsx`, `mobile/app/(tabs)/_layout.tsx`, `mobile/app/(tabs)/calendar/index.tsx`.
- `mobile/src/features/calendar/CalendarScreen.tsx` (currently a shell).
- All current files in `mobile/src/features/plans/`, `mobile/src/storage/planStorage.ts`, `mobile/src/types/plan.ts`, and the four `mobile/tests/plan-*.test.mjs` files. Study hydration, immutable subscriptions, persist-before-commit, busy locks, captured draft dates, sheet identity guards, foreground/focus/timer refresh and the final UTC timestamp fix. Reuse patterns without refactoring Plans.
- `mobile/src/components/{Screen,AppText,Card,SegmentedControl,SectionIntro}.tsx`; `mobile/src/theme/{colors,spacing,radius,typography,shadows,index}.ts`.
- `mobile/package.json`, `mobile/package-lock.json`, `mobile/app.json`, `mobile/tsconfig.json`, `mobile/eslint.config.js`, `mobile/node_modules/expo/bundledNativeModules.json`.

## Calendar domain and UI decisions

Mirror the web type in `mobile/src/types/calendar.ts`, with provenance comment and no runtime import from root:

```ts
export type CalendarEvent = {
  id: string;
  title: string;
  date: string;       // local calendar date YYYY-MM-DD
  time?: string;     // local wall-clock HH:mm; absent means untimed
  note?: string;
  reminder?: string; // existing human-readable domain value
  createdAt?: string;
  updatedAt?: string;
};
```

No completion, Assignment dueDate, duration, timezone, persisted row number or notification ID fields on CalendarEvent. Keep notification bookkeeping in the storage envelope separately.

- Native month grid: Monday first, previous/next month, actual today marker, selected day and event dots; blank cells are not actionable. Explicit Today returns to the current month/day. Cold launch selects today. Month arrows select day 1 of the destination month; a day tap selects that date. Retain month/selection across tab switches in the session. Midnight refresh updates the today marker without moving an explicitly selected date. No persisted UI preferences required.
- Selected-day agenda: timed events ascending HH:mm, untimed last, equal times in stored array order. Append new events; edits preserve identity/array position; derived sorting never rewrites stored order. No numbered PlanTask treatment.
- Tap an event to read full title/note and edit or delete with native confirmation. Editor has title, date, optional exact minute time, note and additional-reminder choices. Date changes move the event to that day's agenda. Saving keeps the calendar on the saved event's day/month.
- Use SDK-compatible `@react-native-community/datetimepicker` for date/time, with a separate “Без времени” toggle. Store date/time strings, never picker Date objects. Use device timezone and 24-hour display where supported. New event defaults: captured selected date, 18:00, “За 30 минут”; existing event fields remain intact. Untimed events have no notification.
- New/edit title: trim outer whitespace, 1–300 characters; note optional, outer trim, maximum 1000. Preserve internal newlines. Reject overlength edits visibly, never truncate. Existing structurally valid long strings remain loadable/readable; edits must satisfy input limits. New IDs are `event-${Crypto.randomUUID()}`, injected in pure tests and generated once per submission. Preserve createdAt on edit; update updatedAt using a canonical UTC ISO timestamp.
- Preserve actual web reminder semantics: every timed event gets an event-time alert; optional advance is 10, 30 or 60 minutes. UI strings remain “За 10 минут”, “За 30 минут”, “За 1 час”, “Только в момент события”. Last choice means exactly one event-time notification. Explain this in native copy without mentioning Telegram.
- Pure reminder parser retains existing recognition of minute/hour/day strings capped at 10080 minutes; missing/empty/“Не напоминать”/unrecognized reminder means no *additional* alert, consistent with the current web scheduler. Preserve unknown stored strings on load and unchanged edits; do not silently rewrite them. Do not reinterpret these legacy values as disabling the event-time alert. No freeform reminder input or recurrence UI.

## Date and timezone contract

Use device-local floating calendar dates/times, consistent with the planner UI. Do not inherit the server's configured Europe/Kyiv default or import its scheduler. A device timezone change keeps the stored date and clock time and changes the derived notification instant on the next app reconciliation.

- Strictly validate real date components and HH:mm (00:00–23:59). Support years 0001–9999 in helpers without JavaScript's constructor remapping of years 0–99. Use calendar arithmetic for month/day navigation, not milliseconds-per-day or `toISOString().slice(0,10)`.
- Resolve wall time with local Date component setters/constructors and check the resulting local components exactly. A nonexistent DST time is a validation error on save, never silently shifted. Previously stored events that become nonexistent after a timezone change stay readable and editable; show an unscheduled-time warning and cancel their old pending requests rather than rejecting the entire snapshot.
- For ambiguous fall-back wall times, choose the earlier occurrence (JavaScript compatible local Date behavior) and test/document that policy. Do not schedule two occurrences.
- Advance reminders subtract elapsed minutes from the resolved event instant, including across midnight/DST. Derive one-shot absolute triggers from these instants.
- Schedule only instants strictly later than the injected current clock; recheck immediately before scheduling. If the advance has passed but the event is future, schedule only the start. Past events remain valid stored data, with no immediate/catch-up/repeating alert. Never use a null trigger as a fallback.
- UTC metadata validation is independent of local timezone: strict canonical `YYYY-MM-DDTHH:mm:ss.sssZ`, finite parse and `new Date(parsed).toISOString() === input`. Under Europe/Kyiv accept `2026-03-29T03:30:00.000Z`; reject `2026-02-30T12:00:00.000Z`. Preserve Slice 2's tests and implementation unchanged.
- A small root-mounted lifecycle hook hydrates Calendar and reconciles on startup, foreground and a cleaned-up 60-second active-app recheck. Calendar focus also refreshes today and requests reconciliation. Coalesce concurrent calls; no interval work while backgrounded and no background JS service. Recompute future targets so clock/timezone changes are detected even if today's date is unchanged. Never reload persisted event data over current state on focus.
- Absolute OS requests cannot be corrected while the app is terminated after a timezone change. Document that they are corrected on the next launch/foreground; do not claim background timezone tracking.

## Durable storage and operation ownership

Use existing AsyncStorage with only **`workazy-native-calendar-v1`**. Never read/write/delete `workazy-native-plan-v1` or browser storage. One envelope and one feature store; no new state framework or database.

```ts
type CalendarNotificationRecord = {
  eventId: string;
  kind: 'start' | 'advance';
  identifier: string;
  fingerprint: string; // stable signature of intended instant and displayed content
  triggerAt: string;   // canonical UTC ISO
};
type CalendarSnapshotV1 = {
  version: 1;
  events: CalendarEvent[];
  notificationRecords: CalendarNotificationRecord[];
  savedAt: string;
};
```

Records are a durable registry of notification IDs that may exist in the OS, **not proof of successful scheduling**. Records referencing deleted events are valid cleanup tombstones. Registry fingerprints may temporarily describe older event revisions; that is recoverable, not snapshot corruption.

Parser validates the whole envelope, unique nonempty event IDs, real date/time formats, string field types, UTC metadata, registry kind/ID/instant/signature shapes and unique notification identifiers. IDs must belong to the specified Calendar namespace. Do not reject a valid date/time string merely because it is a DST gap in the current timezone. Unknown version, malformed JSON or invalid rows => load-error, original bytes untouched, mutations and OS reconciliation blocked, Retry available. Missing key => ready empty state. No seed events, silent repair, migration from Plans or reset button.

Use a pure `createCalendarStore` factory with injected key/value storage, clock, ID generator and notification adapter. Native binding creates one singleton; subscribe with cached immutable snapshots and `useSyncExternalStore`. Hydration coalesces and is idempotent. No pre-hydration autosave or React updater side effects.

A single synchronous operation lock covers user mutations and registry/reconciliation writes. UI disables mutation controls while busy; overlapping user submissions return typed busy without side effects. Lifecycle requests coalesce for one follow-up pass after the lock releases. Always release in finally. No two independent writers of the envelope.

Persist the desired event mutation **before** publishing it or touching the OS. Failed primary storage write leaves committed events/registry and OS unchanged and preserves editor draft. After successful event persistence, notification failure must not roll the event back or encourage a second Add: return an explicit saved-with-notification-warning result, keep a visible retry status on Calendar. Successful deletion removes the event durably but retains its registry until cancellation is confirmed. If cancellation fails, say that an old reminder may still fire and offer Retry; do not claim full cancellation success.

## Notification adapter and reconciliation

Use `mobile/src/services/notifications/` with a pure contract and reconciler separate from the Expo binding. Contract covers permission query/request, list pending requests, schedule a request with an explicit identifier, and cancel one identifier; inject fake implementations for tests. Do not build a general multi-domain notification framework.

Install inside mobile with `npx expo install expo-notifications @react-native-community/datetimepicker`; the installed Expo SDK currently lists notifications `~57.0.17` and datepicker `9.1.0`. Keep framework versions. Add their config plugins as required by installed documentation; no push setup, APNs credentials, background modes or EAS project required for this local-only feature.

API reference, checked during brief preparation: [Expo SDK 57 Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/). Use `getPermissionsAsync`, `requestPermissionsAsync`, `getAllScheduledNotificationsAsync`, `scheduleNotificationAsync` and `cancelScheduledNotificationAsync`. Schedule explicit `identifier` with `{ type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(epochMs) }`. Check returned identifier. Set a foreground handler once using `shouldShowBanner`, `shouldShowList`, `shouldPlaySound`, `shouldSetBadge`; avoid deprecated `shouldShowAlert`. Interpret iOS authorization status, including provisional authorization, rather than only generic permission status. Confirm signatures against installed types. Never copy remote-token examples from the docs.

Implement this bounded reconciliation protocol:

1. After valid hydration, list OS requests and read current permission without prompting. Compute desired future start/advance requests from committed events and current local timezone.
2. Use deterministic identifiers `workazy.calendar.v1:<eventId>:<kind>` and ownership metadata `{ owner: 'workazy-calendar-v1', eventId, kind, fingerprint }`. Encode eventId safely if needed, consistently in validation and generation. Notification title is Workazy, body contains the event title/time; exclude note and never log user text. Fingerprint includes trigger instant, event title/time and kind so title-only edits update content.
3. Persist a registry record **before** first scheduling its ID. For changed requests, cancel the old ID and confirm its absence before scheduling the replacement with the same deterministic ID. If cancellation fails, stop replacement for that ID and expose retry. Do not generate a fresh UUID for every retry.
4. Compare desired requests against OS pending inventory, not registry alone. Matching inventory is a no-op. Missing future requests are scheduled; obsolete requests for edited/deleted/untimed/past events are cancelled. Owned orphan requests absent from the registry (crash recovery) are discovered through namespace plus ownership metadata and cancelled or adopted to match desired data. Never cancel another feature's requests or call cancelAll.
5. After scheduling, verify the returned ID and pending request. Keep sufficient registry information until successful cleanup is confirmed; only then remove obsolete records with another durable envelope write. A metadata write failure must not lose event data or cause duplicate retries. Never erase a tombstone before confirmed cancellation.
6. OS and AsyncStorage cannot transact together: cover crashes after event commit, after registry write, after cancel and after schedule. On restart, current events plus durable registry plus owned OS inventory must converge. No persisted “scheduled=true” shortcut. Inventory/list failure is a visible retryable error; do not blindly schedule or discard IDs.
7. Use a deliberate bounded queue: schedule the earliest **48** future Calendar requests ordered by instant/eventId/kind, reduced to keep total pending requests at most 48 when unrelated requests exist. This is an app policy, not a claimed universal OS limit. Cancel owned requests outside this window; preserve all events. Clearly show when later reminders are not yet scheduled because of capacity and retry/refill on lifecycle reconciliation. No silent dropping or promise of unlimited reminders while the app stays closed. Unit-test the boundary. Do not implement a background refill service.
8. A reminder already delivered is not recalled by deleting an event. Never reschedule past triggers as immediate alerts. Repeated reconciliation must converge without cancel/reschedule churn of unchanged future requests. OS delivery remains subject to user/system notification settings; scheduled inventory is not evidence of delivery.

## Permission flow and native UI safety

- No startup/focus OS prompt. Calendar shows a compact contextual “Включить уведомления” action when needed; explain that events save locally regardless. Explicit user action requests alerts/sound (no badges, critical alerts or provisional request). Provisional authorization, if encountered, is usable but labeled quiet delivery.
- Denied or cannotAskAgain: retain events, show reminders unavailable and offer React Native `Linking.openSettings()` with error handling. No repeated prompting, fake success or browser navigation. Returning foreground rechecks permission and reconciles. Revoked permission cancels owned pending requests where possible and retains cleanup IDs until confirmed; granting later schedules only future targets.
- Register foreground presentation at the root so alerts work while Plans is selected; keep existing theme, Stack and status bar unchanged. Root initialization must not block navigation if Calendar load/notifications fail. Tapping a notification may perform the OS default app launch; event deep-linking is explicitly deferred.
- Reuse existing Workazy components/tokens. Month grid and agenda use one vertical scrolling surface (e.g. FlatList with header), never nested same-axis scroll lists. Preserve safe-area/tab insets and all four tabs. No Calendar library or app-wide styling changes.
- Editor is a native full-screen Modal with its own safe areas, keyboard avoidance, scrollable fields and reachable Save/Cancel. Capture date and draft identity at open. Guard dirty dismissal/Android back; no unguarded swipe loss. Lock fields/close while save is pending; only a completion for the same sheet identity/revision may close it. Error retains full draft; notification warning after durable save must not leave an apparently unsaved Add form.
- Minimum 44pt interactive targets, scaled text, Russian accessible labels, selected date/state and event-count descriptions. Today versus selected uses more than color alone. Fit seven day targets on compact iPhone by reducing horizontal padding, not hit size; avoid fixed-height clipping with large text. Loading, corrupt data, empty day, pending scheduling and failure are distinct states.

## Exact allowed files

Edit existing files only:

| File | Scope |
| --- | --- |
| `mobile/src/features/calendar/CalendarScreen.tsx` | Calendar workspace and wiring. |
| `mobile/app/_layout.tsx` | Mount Calendar lifecycle hook and foreground notification initialization only; preserve navigation/theme. |
| `mobile/app.json` | Required local notifications/datepicker plugin configuration only. |
| `mobile/package.json`, `mobile/package-lock.json` | Two SDK-compatible runtime additions only; existing test command already discovers new tests. |
| `mobile/README.md`, `mobile/MIGRATION_STATUS.md` | Actual Slice 3 behavior, architecture decisions, checks, limitations and pending native evidence. |

Create only these files; keep additional helpers within them:

```text
mobile/src/types/calendar.ts
mobile/src/storage/calendarStorage.ts
mobile/src/features/calendar/calendarDates.ts
mobile/src/features/calendar/calendarModel.ts
mobile/src/features/calendar/calendarStore.ts
mobile/src/features/calendar/useCalendarStore.ts
mobile/src/features/calendar/useCalendarLifecycle.ts
mobile/src/features/calendar/CalendarMonth.tsx
mobile/src/features/calendar/CalendarEventRow.tsx
mobile/src/features/calendar/CalendarEventSheet.tsx
mobile/src/features/calendar/calendarSheetGuard.ts
mobile/src/services/notifications/calendarNotificationContract.ts
mobile/src/services/notifications/calendarNotificationPlanner.ts
mobile/src/services/notifications/calendarNotificationReconciler.ts
mobile/src/services/notifications/expoCalendarNotifications.ts
mobile/tests/calendar-dates.test.mjs
mobile/tests/calendar-model.test.mjs
mobile/tests/calendar-store.test.mjs
mobile/tests/calendar-notifications.test.mjs
mobile/tests/calendar-sheet-guard.test.mjs
```

Everything else is read-only, including this brief, root dependencies/config/web code, Plans implementation/tests/storage, shared theme/components, tab layout and all route files. No generated native ios/android projects committed, no later-slice placeholders. `dist`, `.expo` and node_modules are verification outputs only. Do not edit harness/reference files or repair pre-existing web failures.

## Meaningful automated tests

Use current `node --import tsx --test` tooling. Pure modules import neither RN nor Expo; use real production parser/store/planner/reconciler with injected in-memory storage and fake OS inventory. Fakes must maintain scheduled requests by ID, support failure/deferred promises and survive construction of a fresh store. Assert observable stored bytes, event state, OS requests and operation order, not source-text matches or a reimplementation of production algorithms.

Required coverage:

- Leap years, impossible date/time, month/year boundaries, Monday-first grids; Kyiv spring gap `2026-03-29 03:30` rejected, fall fold `2026-10-25 03:30` chooses earlier occurrence; Los Angeles gap/fold; reminder subtraction across day/DST; local dates near UTC midnight.
- Exact valid UTC DST-gap timestamp above accepted, impossible UTC timestamp rejected. A real write through the store and load into a **new** store restores events and registry with that savedAt/createdAt, including under Kyiv. Serializer-only roundtrip is insufficient.
- CRUD preserves IDs/createdAt, stable equal-time order, untimed sorting, note/newlines and other dates. Default/10/30/60/start-only/legacy reminder mapping; no PlanTask semantics or Plan key writes.
- Missing/corrupt/unknown-version snapshots, invalid registry and duplicate IDs: no overwrite or OS mutation. Retry after read failure; hydration coalescing; mutation before ready; overlapping writes; failed write preserves draft/committed data and invokes no OS operations.
- Add schedules two correct IDs; start-only schedules one; time/date/title/reminder edits replace affected requests; timed-to-untimed and deletion cancel all owned IDs; unrelated notifications survive. Same-time duplicate-titled events remain independent.
- Repeated reconcile/restart/focus is idempotent; real fresh-store persistence plus fake OS inventory verifies no duplicates. Fault injection at every protocol boundary, including cancellation/scheduling/list/storage failure and schedule success before metadata write failure; recovery converges and retains cancellation tombstones. Deferred operations cannot overwrite a newer event revision.
- Past advance/future start, fully past event, permission denied/provisional/granted/revoked, timezone-change invalid time, capacity window and refill. No immediate null triggers, catch-up storm or silent “scheduled” on failure.
- Sheet identity/revision and busy-save guard tests exercise the helper actually used by the component. Keep all existing Plan tests unchanged. Document lifecycle/modal/VoiceOver behaviors requiring native acceptance rather than pretending helper tests render RN.

## Verification and acceptance

From repository root, capture starting/final `git status --short` and `git diff --stat`; inspect untracked mobile files explicitly and compare baseline hashes for forbidden files. Run `git diff --check` plus whitespace review of new files.

From `mobile/`:

```bash
npm test
TZ=UTC npm test
TZ=Europe/Kyiv npm test
TZ=America/Los_Angeles npm test
npm run typecheck
npm run lint
npx expo install --check
npx expo-doctor
npm run export:ios
```

Use installed tools; if dependency installation/network/doctor is blocked, report the actual blocker without claiming a pass. Run root `npm run build` to check isolation; do not change root to fix unrelated failures. Existing root Telegram failure is not a Slice 3 regression when the relevant files remain unchanged. Review runtime imports under `mobile/app` and `mobile/src` for Telegram, localStorage, Next.js, Cloudflare, HTTP clients and reminder-tick leakage; comments/provenance are not runtime dependencies.

Native acceptance on an available iPhone build (`cd mobile && npx expo run:ios --device`, or simulator without `--device` where supported; generated native folders remain uncommitted):

1. Cold launch still opens Plans, exactly four tabs, Plans segments/Today–Tomorrow/completion/order/storage intact. No unsolicited permission dialog.
2. Calendar month/day navigation, dots, empty states, full text, timed/untimed CRUD and restart persistence work. Keyboard, compact/notched iPhone, large text and VoiceOver remain usable.
3. Explicitly enable notifications, schedule a near-future event with an advance reminder; observe both once, including foreground and background/locked state where supported. Inspect pending inventory: expected IDs/times only. Change title/time/reminder before firing and verify replacement; delete before firing and verify cancellation.
4. Deny permission and save events; return from Settings after enabling and verify future scheduling. Test restart, failed operations, timezone/clock change, past reminders and capacity warning. No claim that scheduled inventory or JS export proves OS delivery.

When Xcode/device access is unavailable, finish unit/type/lint/bundle checks and mark native launch/delivery/visual/accessibility acceptance **pending** in README/status. Preserve earlier pending Slice 1/2 acceptance and remove stale statements that Calendar/notifications are wholly deferred only where Slice 3 actually implements them. No fabricated screenshots or notification evidence.

Accept when functional flows and automated risk tests pass, desired events survive errors/restart, notification reconciliation converges without duplicates/orphaned known IDs, previous slices are unchanged, and native evidence or its exact pending status is honest.

## Regression risks and DeepSeek handoff

Main risks: conflating additional/start reminders; persisting events but losing cancellation IDs; destructive corrupt-data recovery; duplicate alerts after partial failure; local/UTC confusion; rescheduling past alerts; stale async sheets losing text; lifecycle churn; root initialization breaking Plans; and claims exceeding actual native evidence. The protocol, fault-injection tests and explicit UI statuses above are required safeguards, not optional polish.

Implement in one pass: inspect and record baseline; build/test domain/date/storage; build/test notification planner and reconciliation with failures; wire native binding and UI; run checks and fix slice-introduced failures; update only allowed documentation; stop. Do not ask the user to choose routine details resolved here or start Slice 4. If a hard environment blocker prevents a check, complete independent work and report it precisely.

Final implementer report: exact changed files, working flows, preserved event/start-plus-advance semantics, persistence/notification ID and timezone decisions, exact commands/results, regressions checked, native evidence or pending status. State that data is local to this installation, unsaved drafts are not process-durable, no web sync exists, notification failures/capacity have visible retry states, and timezone correction/refill require app execution. Never declare the whole migration complete.
