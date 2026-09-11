# Workazy Autonomous Harness

## Purpose

Use one reasoning model as architect/reviewer and one fast coding model as implementer.

The harness should continue through multiple implementation slices without waiting for manual prompting after every file.

## Suggested roles

### ARCHITECT
Responsibilities:
- understand repository
- create migration decisions
- choose API reuse
- produce acceptance criteria
- review every completed slice
- block regressions
- resolve difficult bugs

### IMPLEMENTER
Responsibilities:
- implement only the current accepted slice
- run checks
- fix ordinary failures
- report exact changes
- never change product scope on its own

## Loop

```text
START
  ↓
ARCHITECT: inspect repository + current MIGRATION_STATUS
  ↓
ARCHITECT: choose one coherent slice + write acceptance criteria
  ↓
IMPLEMENTER: implement
  ↓
IMPLEMENTER: run typecheck/lint/tests
  ↓
REVIEWER: inspect diff + failures + UX constraints
  ↓
PASS? ── no ──> IMPLEMENTER fixes
  │
 yes
  ↓
update MIGRATION_STATUS
  ↓
next slice
  ↓
until Definition of Done
```

## Context files always loaded

The orchestrator should always provide:
- `MASTER_PROMPT.md`
- `AGENTS.mobile.md`
- `MOBILE_ARCHITECTURE.md`
- `DESIGN_SYSTEM.md`
- `tasks/mobile-migration.md`
- `mobile/MIGRATION_STATUS.md` if present

The visual model/agent should also inspect `/references`.

## Architect prompt

```text
You are Workazy's architect and reviewer.

Read the harness context files and inspect the actual repository before making decisions.
Do not redesign the product.
Do not write broad speculative plans if code can be inspected.

For the current iteration:
1. determine the next incomplete migration slice;
2. identify existing web/backend code to reuse;
3. define exact files/interfaces to create or change;
4. list acceptance criteria;
5. identify regression risks;
6. hand a concise implementation brief to the implementer.

After implementation:
- inspect the diff,
- run/review tests,
- reject fake UI or broken persistence,
- verify there is no Telegram dependency in the mobile runtime,
- verify design against references,
- approve only when the slice is complete.
```

## Implementer prompt

```text
You are the Workazy implementation agent.

Follow the architect brief plus:
MASTER_PROMPT.md
AGENTS.mobile.md
MOBILE_ARCHITECTURE.md
DESIGN_SYSTEM.md
tasks/mobile-migration.md

Inspect existing code before editing.

Implement the current slice completely.
Do not stop after scaffolding.
Do not replace working backend logic unnecessarily.
Do not introduce Telegram into mobile.
Do not ship fake buttons.
Do not hard-code dates.
Do not lose user data.

Run all relevant checks.
Fix failures you can fix.
Return:
- files changed,
- behavior implemented,
- tests/checks run,
- remaining blocker if any.
```

## Reviewer rejection triggers

Reject the implementation when any of these is true:
- WebView used as the app
- Telegram included in native runtime
- recording UI is fake
- video requires hold instead of one-tap toggle
- media stored as base64 in planner state
- hard-coded date
- plan completion resets
- journal long text cannot scroll
- bottom navigation covers content
- keyboard covers save controls
- finance daily limit logic regresses
- no permission handling
- no error handling
- lint/typecheck/test failure ignored
- reference design is not followed

## Operational advice

If your coding environment can launch subagents, map:
- architect/reviewer -> strongest reasoning model
- implementer -> fast coding model

If it cannot launch true subagents, use the same loop sequentially with explicit role switching and keep state in `mobile/MIGRATION_STATUS.md`.

The harness state file is more important than conversation memory.
