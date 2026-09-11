# Workazy Mobile Architecture

## Goal

Add a native iPhone client without destabilizing the existing Workazy web app.

## Recommended topology

```text
workazy/
├─ app/                         # existing web UI/API
├─ lib/                         # existing web/domain/backend
├─ db/                          # existing database schema
├─ tests/                       # existing tests
└─ mobile/
   ├─ app/                      # Expo Router routes
   │  ├─ _layout.tsx
   │  ├─ onboarding.tsx
   │  └─ (tabs)/
   │     ├─ _layout.tsx
   │     ├─ plans/
   │     ├─ calendar/
   │     ├─ records/
   │     └─ finance/
   └─ src/
      ├─ components/
      ├─ features/
      │  ├─ plans/
      │  ├─ tasks/
      │  ├─ goals/
      │  ├─ calendar/
      │  ├─ journal/
      │  ├─ ideas/
      │  └─ finance/
      ├─ services/
      │  ├─ api/
      │  ├─ media/
      │  └─ notifications/
      ├─ storage/
      ├─ theme/
      ├─ types/
      └─ utils/
```

## Why a sibling native app

The existing project is web-oriented. Keeping the new native client in `mobile/`:
- protects the working web app
- allows gradual migration
- makes native dependencies isolated
- keeps one GitHub repository
- lets both clients use the same backend/API

## State layers

### UI state
Local component state or a small feature-level store.

### Durable local state
Use native storage:
- AsyncStorage for simple preferences/small state, or
- SQLite if the migration needs reliable structured offline data

Do not use browser localStorage in the native app.

### Server state
Use a thin API client that mirrors the existing Workazy server contracts.

The mobile application should be able to:
- load state
- save changes
- recover from network errors
- avoid overwriting newer state blindly

If the existing planner sync is snapshot-based, keep compatibility first and improve conflict handling later.

## Domain compatibility

Mirror the existing `lib/types.ts` domain shape in native code.

Do not redesign data just to fit a new UI.

Important existing concepts:
- plan item completion
- date-specific plan items
- assignments
- goals + progress
- journal entry + optional media metadata
- event + reminder
- idea category/status
- finance expenses, salary schedules, obligations

## Journal media

Keep the existing principle:
- planner state stores media metadata
- binary audio/video goes to media storage
- upload returns metadata
- transcript is attached to media metadata

Native flow:

```text
Camera/Mic
  ↓
temporary local file
  ↓
preview
  ↓
user confirms
  ↓
multipart upload
  ↓
existing media API
  ↓
R2/object storage
  ↓
metadata associated with JournalEntry
```

Do not base64-embed recordings in planner state.

## Notifications

Create:

```text
mobile/src/services/notifications/
  NotificationService.ts
  ExpoNotificationService.ts
  reconcileReminders.ts
```

Interface example:

```ts
type NotificationService = {
  requestPermissions(): Promise<boolean>;
  scheduleCalendarEvent(event: CalendarEvent): Promise<string | null>;
  scheduleFinanceObligation(item: FinanceObligation): Promise<string | null>;
  cancel(id: string): Promise<void>;
  reconcile(input: ReminderSnapshot): Promise<void>;
};
```

Initial v1 uses local scheduled notifications.

This replaces the need for Telegram in the mobile experience.

## Camera/video

Create a dedicated recorder route, not an embedded tiny camera inside the journal form.

Suggested route:
`/records/journal/video-recorder`

Flow:
1. permission gate
2. camera view
3. one-tap start
4. one-tap stop
5. preview
6. save/re-record
7. return media draft to journal editor

## Audio

Same lifecycle, separate service/component:
- record
- stop
- preview
- attach
- upload after journal save or through a draft-entry strategy

## Design implementation

Create design tokens first:

```text
mobile/src/theme/
  colors.ts
  spacing.ts
  radius.ts
  typography.ts
  shadows.ts
  index.ts
```

Avoid raw one-off values scattered across screens.

## Error boundaries

Handle:
- offline
- API timeout
- media upload failure
- denied camera permission
- denied microphone permission
- denied notifications
- recording interrupted
- file missing
- server transcript failure

Never discard text entry because media upload failed.

## Migration strategy

Phase A:
- scaffold
- theme
- navigation
- read-only API adapter

Phase B:
- plans/tasks/goals
- persistence

Phase C:
- calendar + notifications

Phase D:
- journal text + history + ideas

Phase E:
- native audio/video + uploads

Phase F:
- finance

Phase G:
- polish, regression testing, iPhone verification

The harness may execute continuously, but each phase must pass checks before the next one.
