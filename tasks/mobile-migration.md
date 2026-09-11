# TASK — Build Workazy Native iPhone App

Execute the migration defined in:
- `MASTER_PROMPT.md`
- `AGENTS.mobile.md`
- `MOBILE_ARCHITECTURE.md`
- `DESIGN_SYSTEM.md`

## Required implementation slices

### Slice 1 — Audit + scaffold
- inspect current Workazy web app and backend
- document reusable APIs/domain logic
- create `mobile/`
- configure Expo/TypeScript
- create theme tokens
- create 4-tab navigation
- create `mobile/MIGRATION_STATUS.md`

Acceptance:
- native app launches
- tabs work
- no Telegram dependency
- typecheck/lint pass

### Slice 2 — Plans
Implement:
- Today screen
- Plan
- Tasks
- Goals
- completion state
- date selection
- add/edit/delete where supported
- long text viewing

Acceptance:
- state persists
- completion does not randomly reset
- no hard-coded date

### Slice 3 — Calendar + notifications
Implement:
- month calendar
- selected day
- event CRUD
- exact time
- reminder offset
- native local notification scheduling/cancel/reconcile

Acceptance:
- reminder fires on simulator/device where supported
- deleting event cancels reminder
- no Telegram call occurs

### Slice 4 — Journal + Ideas
Implement:
- journal text
- title
- mood
- tags
- history
- long scrolling entry
- Ideas tab and existing categories/statuses

Acceptance:
- long journal text scrolls
- edits persist
- media failure cannot delete text

### Slice 5 — Native audio/video
Implement:
- audio recording
- video recording
- one-tap start/stop
- timer
- camera flip
- permissions
- preview
- re-record
- upload
- metadata association
- transcript display/edit where backend supports it

Acceptance:
- no hold-to-record
- portrait video
- full-screen recorder
- save produces a journal media item
- denied permission has useful UI
- failed upload is recoverable

### Slice 6 — Finance
Implement:
- balance
- daily limit
- salary schedules
- expenses
- obligations
- reminders

Acceptance:
- expense does not rewrite daily limit incorrectly
- obligation notification scheduling works

### Slice 7 — Polish
- onboarding
- settings
- error/empty/loading states
- safe area
- keyboard
- accessibility
- visual pass against `/references`
- README

## Delete/isolate mobile-irrelevant behavior

Search for:
- `telegram`
- `TELEGRAM_`
- `/api/telegram`
- reminder cron/workflows tied only to Telegram

The new mobile runtime must not depend on them.

Do not blindly delete web production behavior until the mobile path is verified.

## Final report

At completion, print:
1. architecture summary
2. files changed
3. commands run
4. checks passed
5. iPhone verification status
6. remaining limitations
7. exact commands the user should run next
