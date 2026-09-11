# AGENTS.mobile.md — Workazy Native Rules

## Scope

These rules apply to the new `mobile/` application.

## Product truth

Workazy already exists. The mobile app is a migration and improvement, not a new unrelated planner.

Primary navigation:
1. Plans
2. Calendar
3. Records
4. Finance

Plans contains:
- Plan
- Tasks
- Goals

Records contains:
- Journal
- Ideas

## Non-negotiable rules

- iPhone-first native UX.
- Never ship a WebView wrapper.
- Never make Telegram a dependency of the mobile app.
- Preserve existing Workazy data concepts.
- Prefer adapting existing backend/API contracts.
- Do not invent new product sections without a task.
- No hard-coded current date.
- No hard-coded timezone offset.
- Keep date calculations local-time aware.
- Protect user-created text/media from accidental loss.
- Long entries must scroll.
- Bottom navigation must respect safe areas.
- Forms must remain usable with the keyboard open.
- Keep tap targets comfortable for touch.
- Use accessible labels for icon-only actions.

## Recording UX

### Video
The journal video flow is full-screen:
- tap record once -> start
- tap same control again -> stop
- show elapsed time
- allow camera flip
- allow cancel
- show preview
- save or re-record

No hold-to-record.

### Audio
- tap once -> start
- tap again -> stop
- timer
- preview
- save / re-record

## Notifications

Use native notification infrastructure.

Do not use:
- Telegram bot
- Telegram chat ID
- Telegram API
- Telegram webhook
- Telegram cron delivery

Initial reminder strategy:
- schedule local notifications from calendar and finance data
- reschedule when event/obligation changes
- cancel when deleted/completed
- reconcile schedules on app startup

## Data

The existing web domain model includes:
- PlanTask
- Assignment
- Goal
- JournalEntry
- JournalMedia
- CalendarEvent
- Idea
- SalarySchedule
- FinanceExpense
- FinanceObligation
- FinanceState

Do not casually rename these concepts.

## Backend

Reuse the current backend/media architecture where it is still useful.

Do not move binary media into planner JSON state.
Keep media metadata separate from binary storage.

## Design system

Follow `/references`.

Theme:
- dark
- minimal
- premium
- restrained tech gradient
- violet as primary accent
- mint only when semantically justified
- low-contrast borders
- rounded cards
- high contrast text
- subtle motion only

Avoid:
- neon overload
- giant gradients behind every block
- glassmorphism everywhere
- random shadows
- tiny text
- desktop-like tables
- excessive nested tabs

## Engineering rules

Before changing code:
1. Inspect the existing implementation.
2. Identify the smallest reusable domain/API layer.
3. Record migration decision in `mobile/MIGRATION_STATUS.md`.

After each coherent feature:
1. Typecheck.
2. Lint.
3. Run tests.
4. Verify on iPhone simulator where possible.
5. Review against the reference screenshots.

Do not mark a task complete if only the UI exists but persistence/actions are fake.

## Agent collaboration

Architect writes decisions and acceptance criteria.
Implementer executes them.
Reviewer checks:
- data safety
- native correctness
- visual consistency
- unnecessary complexity
- regression risk
- Telegram leakage
- test coverage

If reviewer rejects a slice, implementer fixes it before starting the next slice.
