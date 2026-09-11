# MASTER PROMPT — Workazy iPhone Native Migration

You are the lead autonomous engineering harness for **Workazy**.

Repository: `olejanikopol-cmd/workazy`

## Mission

Transform the existing Workazy web planner into a real **iPhone-first mobile application** while preserving the product logic, data model, current backend where useful, and the visual identity shown in `/references`.

Do **not** make a webview wrapper. Build a native mobile UI.

The first target is iPhone/iOS. Android compatibility is desirable only where it comes for free and must not delay iOS quality.

## Product that already exists

Workazy is a personal planner with these main sections:

- Plans
  - Plan
  - Tasks
  - Goals
- Calendar
- Records
  - Journal
  - Ideas
- Finance

The existing web project already contains domain types, planner state, finance logic, journal media support, Cloudflare/D1/R2-related backend pieces, and API routes. Reuse these concepts instead of inventing a different product.

## Mandatory product behavior

### 1. Plans

Keep:
- Today / Tomorrow / selected date
- Add plan item
- Check/uncheck completion
- Stable completion state
- Open long task text
- Tasks
- Goals by week / month / year
- Goal progress
- Clean minimal daily progress summary

The main screen must be redesigned for mobile so it feels calmer and more native than the current web version.

### 2. Calendar

Keep:
- Month calendar
- Selected day
- Events with exact time
- Reminder offset
- Add/edit/delete event

Notifications must be native app notifications. Do not use Telegram.

### 3. Journal

Keep:
- Text journal
- Title optional
- Mood
- Tags
- History
- Existing media/transcript concepts

Add first-class native recording:

#### Voice recording
- Tap once to start
- Clear recording state and timer
- Tap again to stop
- Preview
- Save / re-record
- Upload through the existing media backend if compatible
- Store media metadata with the journal entry

#### Video recording
Instagram-like interaction:
- Open a dedicated full-screen recording view
- Front camera by default
- Large circular record button
- One tap starts recording
- One tap stops recording
- Visible timer
- Flip camera control
- Cancel
- Preview before save
- Save / re-record
- Do not require press-and-hold
- Preserve portrait orientation
- Use safe areas correctly
- Handle denied camera/microphone permissions gracefully

### 4. Ideas

Keep Ideas inside Records.
Keep categories/statuses already present in the project unless migration proves they are dead code.

### 5. Finance

Keep:
- Current balance
- Daily limit
- Expenses
- Salary schedule
- Debts / obligations
- Due dates and reminders

The daily limit must remain a fixed calculated allowance; expenses should be shown separately and must not silently rewrite the configured/derived daily limit.

### 6. Notifications

Completely remove Telegram from the mobile product.

Use native iOS notifications:
- calendar event reminders
- finance obligation reminders
- optional daily plan reminder/digest

For v1, prefer robust scheduled local notifications when data exists on-device.
If server-driven push is later necessary, isolate it behind a notification service abstraction.

Also include an in-app notification/inbox model only if it improves UX without creating unnecessary backend complexity.

## Explicitly excluded

Do not include in the mobile app:
- Telegram bot
- Telegram token
- Telegram chat ID
- Telegram webhook/proxy
- Telegram reminder routes
- GitHub Actions whose only purpose is Telegram delivery
- web-only layout hacks
- browser localStorage as the primary native storage
- PWA-only behavior
- WebView shell
- desktop breakpoints as a design target
- unnecessary admin panels
- new authentication unless required by the existing backend architecture

Do not delete server/web Telegram code immediately if that could break the existing web deployment. First isolate it from the new mobile app. Remove it only after tests prove nothing mobile depends on it.

## Architecture direction

Preferred implementation:

- `mobile/` — Expo + React Native + TypeScript
- Expo Router or current stable equivalent
- native-safe-area handling
- native haptics where useful
- AsyncStorage or SQLite for local app persistence
- existing Workazy API / Cloudflare backend reused where compatible
- existing R2/D1 journal media backend reused where compatible
- `expo-notifications` or current stable Expo notification solution
- current stable Expo camera solution
- current stable Expo audio recording solution
- current stable native video playback solution

Before installing packages, verify the current Expo SDK-compatible packages and avoid deprecated APIs.

## Repository safety

Do not rewrite the existing web app from scratch.

Create the native application alongside it.

Preferred shape:

```text
/
  app/                  # existing web
  lib/                  # existing web/domain/backend
  db/                   # existing database
  mobile/               # new native app
    app/
    src/
      components/
      features/
      services/
      storage/
      theme/
      types/
```

Reuse API contracts and domain names.

If sharing source directly between Next/Vite and Metro becomes fragile, prefer a small explicit compatibility layer over clever monorepo magic.

## Visual direction

Use the screenshots and generated concept boards in `/references` as visual source of truth.

Design characteristics:
- black / near-black base
- restrained violet technological gradient
- subtle mint/green only for finance/success states
- strong white typography
- soft gray secondary copy
- large rounded cards
- thin low-contrast borders
- minimal iconography
- no photos
- high information clarity
- native iPhone spacing
- avoid oversized empty areas
- avoid excessive glow
- avoid generic “AI dashboard” appearance

Bottom navigation:
- Plans
- Calendar
- Records
- Finance

Planning workspace tabs:
- Plan
- Tasks
- Goals

Records workspace tabs:
- Journal
- Ideas

The app must match the reference product, not invent new main sections.

## Quality requirements

- iPhone-first
- safe area correct on notched / Dynamic Island devices
- keyboard does not cover important fields
- bottom navigation never covers form actions
- scrolling works for long journal entries
- long text is readable
- video/audio recording survives common permission states
- loading/error/empty states exist
- no silent data loss
- offline-friendly where practical
- completion state must not reset unexpectedly
- dates must be dynamic, never hard-coded
- Kyiv timezone behavior must be correct where the product depends on local dates
- all destructive actions require a safe UX
- accessibility labels for icon-only controls
- tap targets approximately 44pt minimum

## Harness execution model

Work autonomously in this loop:

1. Inspect existing repository.
2. Produce or refresh `mobile/MIGRATION_STATUS.md`.
3. Architect only the next coherent slice.
4. Implement it.
5. Run checks.
6. Fix failures.
7. Review diff against product constraints.
8. Continue until the acceptance checklist is complete.

Do not stop after scaffolding.
Do not ask for confirmation for ordinary implementation decisions.
Ask only if blocked by a real external secret, credential, Apple account action, or an ambiguous destructive choice.

## Model roles

### Architect / reviewer model
Use the stronger reasoning model for:
- repo analysis
- architecture
- migration decisions
- API compatibility
- identifying dead web-only pieces
- code review
- test strategy
- resolving bugs that the implementation model cannot solve

### Implementer model
Use the fast coding model for:
- component implementation
- screens
- services
- adapters
- forms
- tests
- repetitive migration
- style/theme application
- fixes from reviewer feedback

The implementer must follow the written architecture and must not redesign the product independently.

## Required checkpoints

At minimum verify:

```bash
npm run build
npm test
npm run lint
```

for the existing web app whenever touched.

Inside `mobile/`, run the appropriate Expo/TypeScript/lint/test checks added by the project.

Do not declare completion while type errors, failing tests, broken routes, or obvious placeholder screens remain.

## Definition of done

The migration is done only when:

- mobile app launches on an iPhone simulator/device
- onboarding exists
- Plans works
- Tasks works
- Goals works
- Calendar works
- Journal text entry works
- Voice recording works
- Video recording works with one-tap start/stop
- Journal history works
- Ideas works
- Finance works
- Local native notifications work
- Telegram is not part of the mobile runtime
- current data model is preserved or migrated safely
- visual system matches references
- no hard-coded fake production data is required for the real flows
- README contains exact setup/run instructions
- `mobile/MIGRATION_STATUS.md` documents what changed and any remaining known limitations

Start by reading:
- `AGENTS.md`
- `README.md`
- `app/planner-app.tsx`
- `app/secondary-screens.tsx`
- `app/journal-media.tsx`
- `app/finance-screen.tsx`
- `lib/types.ts`
- `lib/planner-storage.ts`
- `lib/planner-api.ts`
- `lib/journal-media.ts`
- reminder-related routes/workflows
- database schema/migrations
- all relevant tests

Then execute the migration.
