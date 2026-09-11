# Workazy Mobile — iPhone client

Native iPhone client for **Workazy**, a personal planner (планы, календарь, записи,
финансы). This is an independent Expo (SDK 57) + React Native + TypeScript application
using **Expo Router**. No WebView, no Telegram, no browser storage, no web imports.

Slices 1–2 delivered the scaffold, dark theme, four-tab navigation, and the daily
plan (Планы → План) with durable AsyncStorage persistence. **Slice 3** adds the
Calendar tab: Monday-first month grid, selected-day agenda, local CalendarEvent CRUD,
and native local reminders via `expo-notifications`.

## Requirements

- Node.js LTS — verified on Node `v24.19.0` with npm `11.17.0` (Expo SDK 57).
- npm.
- To launch on an iOS simulator/device you need a full Xcode installation with an iOS
  simulator (not required for the checks below).

## Install / start / check commands

```bash
cd mobile
npm install        # first time; afterwards npm ci

npm start          # expo start
npm run ios        # expo start --ios  (requires Xcode + simulator)
npm run android    # expo start --android

npm run typecheck  # tsc --noEmit
npm run lint       # expo lint
npm test           # node --import tsx --test tests/*.test.mjs
TZ=Europe/Kyiv npm test          # DST/timezone runs
TZ=America/Los_Angeles npm test
npx expo install --check
npx expo-doctor
npm run export:ios # expo export --platform ios  → writes dist/
```

## Route map

| Route | Destination |
| --- | --- |
| `/` | redirects to `/(tabs)/plans` |
| `/(tabs)/plans` | **Планы** — План (functional daily plan) / Задания / Цели |
| `/(tabs)/calendar` | **Календарь** — month grid + selected-day agenda (Slice 3) |
| `/(tabs)/records` | **Записи** — Дневник / Идеи segmented switch |
| `/(tabs)/finance` | **Финансы** section shell |
| any other | `+not-found` screen with a return-to-Plans action |

Root `app/_layout.tsx` owns the dark navigation theme, stack, and the calendar
lifecycle hook (foreground notification handler + reminder reconciliation).
`app/(tabs)/_layout.tsx` owns exactly four bottom tabs.

## Daily plan (Slice 2)

- **План** shows the selected relative day (Сегодня / Завтра) with real date, derived
  progress (`done / total / %`), one «Добавить пункт» action and an ordered FlatList.
  Loading and load-error are explicit states — never a fake empty day.
- Add/edit uses a full-screen native modal with multiline input, explicit Save/Cancel,
  validation (non-blank, ≤ 300 chars, outer whitespace trimmed, internal newlines kept)
  and a dirty-close discard confirmation. The target date is captured when the editor
  opens and shown in its header.
- Row checkbox and the text reader are distinct sibling targets with accessible Russian
  labels and checked state. The reader shows the full text (never truncated), the
  completion status, and Edit / Toggle / Move up / Move down / Delete actions (item
  resolved live by ID). Delete requires an Alert confirmation naming the item.
- **Persistence**: AsyncStorage, single key `workazy-native-plan-v1` (distinct from the
  web key), versioned envelope `{ version: 1, tasks, savedAt }`. Hydration gate; no
  autosave and no writes before hydration. Mutations are **persist-before-commit** with a
  synchronous write lock — a second mutation during a pending save returns `busy`.
  On write failure the last committed state stays, the error stays visible, and repeating
  the same action retries. Malformed/unknown snapshots go to load-error with raw bytes
  preserved and a Retry action.
- New IDs are `task-${Crypto.randomUUID()}`; rows are numbered `01, 02, …` per selected
  day; moves swap adjacent same-day rows in the full array. Explicit uncheck stays
  unchecked (no web "completed first" merge).
- Dates use **device-local calendar arithmetic** (`localDateIso` / `getPlanDates`), never
  UTC slicing or fixed offset arithmetic. Relative selection refreshes on foreground and
  at local midnight; stored task dates never shift.
## Calendar + local notifications (Slice 3)

- **Календарь** shows a Monday-first month grid (prev/next month, actual today
  marker, selected day, event dots; blank cells inert; «Сегодня»), the selected
  day's agenda (timed ascending HH:mm, untimed last, equal times in stored
  order), and one add action. Month/selection survive tab switches; cold launch
  selects today.
- Event editor is a full-screen modal: title, date (native datetimepicker), time
  with a «Без времени» toggle, note, and reminder choices («За 10 минут», «За 30
  минут», «За 1 час», «Только в момент события»). Existing reminders are
  preserved exactly. Recognized legacy values (e.g. «За 2 дня») still create an
  advance alert (capped at 10080 minutes); only UNRECOGNIZED values are kept
  verbatim and mean start-only.
- **Local reminders** (`expo-notifications`, iPhone-first): every timed event
  gets an event-time alert; the advance choice adds a second alert. No Telegram,
  no server tick, no push setup. The user must explicitly enable notifications in
  the Calendar tab; events save locally regardless.
- Reminder scheduling is coordinated on every CRUD, app foreground, calendar-screen
  focus, and periodic recheck: a single-flight reconciler (deterministic IDs
  `workazy.calendar.v1:<eventId>:<kind>`) checks each owned request for matching
  content/title/body/kind AND the trigger instant the OS actually holds. An
  undecodable/unknown trigger FAILS verification (persisted metadata only proves
  intent); absolute/date/calendar shapes must match strictly, while only the iOS
  `timeInterval` read-back (native interval computed after the JS call) is
  compared within a conservative scheduling-handoff budget. Mismatches are
  cancelled and rescheduled,
  re-reads the OS inventory before scheduling, keeps a durable registry persisted
  before scheduling (persist failure aborts the pass), re-checks clock +
  event revision immediately before the OS call, verifies each scheduled request
  by read-back with the SAME full matcher (id + ownership + content + trigger),
  and never lets a deleted event regain a notification. A successful schedule consumes capacity immediately
  (max 48 total pending) with refill on later passes, so a failed read-back can
  never exceed the cap. Capacity/failure surfaces as visible banners with retry.
- Dates use device-local floating wall-clock times; Kyiv DST times pick the
  earlier occurrence for fold, the editor refuses to save a spring-forward gap,
  and events that become unschedulable after a timezone change surface a visible
  warning instead of silently losing their reminder (cleared once schedulable
  again). Year handling is exact and 4-digit padded throughout (stored value ↔
  picker ↔ save serialization): years 0001-0099 are never remapped to the 1900s,
  and year 0000 is rejected consistently by validation and conversion (the
  planner domain is 0001-9999).
- Editing and deleting share one synchronous busy lock: while a save/delete (plus
  its awaited reconciliation) is pending, every control is disabled, the screen
  cannot be dismissed, and only a completion carrying the CURRENT editor identity
  may close it — an old completion never closes a newer editor.
- Periodic recheck runs only while the app is active (foreground/60 s), so no
  background timer work is claimed. A permission read/prompt merges into the
  LATEST state after it resolves, so a delayed permission response cannot erase a
  newer scheduling error or a DST-gap warning (or resurrect a cleared one).
- **Persistence**: AsyncStorage key `workazy-native-calendar-v1`, envelope
  `{ version: 1, events, registry, savedAt }`; hydration gate, persist-before-
  commit, busy lock. Registry writes merge into the current committed events, so
  notification reconciliation never overwrites a newer event edit.
- **No startup/focus permission prompt**: the Calendar tab shows a contextual
  «Включить уведомления» action; denied permission shows «Открыть настройки»
  (Linking.openSettings) and never prompts repeatedly.

## Code structure

```text
app/                      # Expo Router routes (root layout mounts calendar lifecycle)
src/theme/                # design tokens: colors, spacing, radius, typography, shadows
src/components/           # Screen, AppText, Card, SegmentedControl, SectionIntro
src/types/plan.ts, calendar.ts         # mirrored web domain types
src/storage/planStorage.ts, calendarStorage.ts  # key/envelope/parser (injected storage)
src/features/plans/       # daily plan (pure model/dates/store + binding + UI)
src/features/calendar/    # calendar (pure model/dates/store + binding + lifecycle + UI)
src/services/notifications/            # pure contract/planner/reconciler + Expo binding
assets/images/            # only launch/icon assets referenced by app.json
```

Pure domain logic lives in the plan/calendar `*Model.ts`, `*Dates.ts`,
`*Storage.ts` and `*Store.ts` modules — the ONLY modules importing AsyncStorage,
Expo Crypto, or expo-notifications are `usePlanStore.ts`, `useCalendarStore.ts` and
`expoCalendarNotifications.ts`. Tests import the pure chain directly with injected
storage/clock/IDs/fake OS.

## Data and backend isolation

- **Data is local to this installation**; the app makes no requests to the product
  server, stores no credentials, and has no cloud/sync claims.
- **No Telegram**, no server reminder tick, no system-calendar integration, no
  recurrence, no push/APNs credentials. Calendar reminders use `expo-notifications`
  local scheduling only; OS delivery remains subject to user/system settings.
- Tasks/Goals CRUD, Journal/Ideas, Finance, media/camera, and later slices remain
  unimplemented.

## Visual references

Visual source of truth is the screenshot set in the repository at `references/`
(copied from the harness bundle `/Users/oleh/Downloads/workazy-mobile-harness/references/`).
The harness bundle must be available on this machine for a visual pass.

## Current limitations (Slice 3)

- Data is local to this installation; no export/import or web-data migration yet.
- Notification delivery is OS/subject to user settings; scheduled OS inventory is
  not evidence of delivery. iOS provisional authorization is labeled quiet.
- Reminder capacity is an app policy: at most 48 total pending requests; later
  reminders refill on later passes (no background refill service).
- Timezone/clock corrections require app execution (foreground/60s recheck);
  the store keeps floating local dates (event dates are never rewritten).
- Untimed events and events whose wall-clock time does not exist in the current
  timezone (DST spring-forward gap) produce no notifications; the editor refuses
  to save a gap time and an already-saved event that becomes unschedulable after
  a timezone change shows a visible warning. Past reminders are never replayed.
- Unsaved editor drafts are not process-durable; termination during a pending
  save is not claimed durable (successful saves restore exactly).
- iPhone simulator/device launch, the OS notification permission prompt, actual
  banner/sound delivery, datetimepicker interactions, and on-device restart
  convergence are **not yet verified** on the implementation machine (only Xcode
  CommandLineTools installed; no simulator). Do not treat Slice 3 as passed until
  native evidence exists. See `MIGRATION_STATUS.md` for exact status.
