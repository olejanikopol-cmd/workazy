# Slice 7 — native iPhone acceptance

**Status: PENDING.** No item below is satisfied by unit tests, static review or
Expo export. This environment cannot run `simctl` (full Xcode is unavailable).
Record device model, iOS version, app version/build, tester, date and observed
result per item. Use a compact iPhone and a notched/Dynamic Island device where
available. Fresh-install tests must use a separate test installation; do not
uninstall a user's copy containing personal data.

## Exact manual checklist

- [ ] Fresh install: four short onboarding pages, progress, Back/Continue/Skip/Start;
  no permission prompt, no sample data. Smaller display and largest useful text size
  keep content/actions scrollable. Complete, terminate, reopen: no onboarding.
- [ ] Settings from Plans: four bottom tabs remain; Back returns to the prior screen.
  Replay all onboarding pages, close early, restart: no data loss or completion reset.
- [ ] Onboarding preference read/write failure: visible retry; failed completion
  stays open. Read-error continuation opens existing app data without resetting it.
- [ ] Empty Plan: add, read long text, edit, check/uncheck, delete with
  confirmation. Today and Tomorrow shortcuts work. Select yesterday and an arbitrary
  future date through Date: add/read/edit/complete/delete affects only that day.
  Switching Plan → Goals → Plan retains the selected date. Restart restores saved
  items when that date is selected again. Check exact text entry for early years
  without a 1900 remap, plus native picker selection/cancel for ordinary dates.
- [ ] Goals: create weekly, monthly and yearly goals; open long text; edit title,
  description, period, deadline and integer progress; complete and reopen; delete
  with confirmation; terminate/restart and confirm exact persistence. Check the
  keyboard, scrolling, touch targets and basic VoiceOver labels/states. Completed
  goals remain available through the visible completed filter.
- [ ] Goals slow-save race where practical: newer input during Save remains visible
  after the earlier payload commits; explicit resave updates the same goal. Rapid
  double Save does not duplicate; failed Save keeps the draft editable; completion
  of an old sheet does not dismiss a replacement sheet.
- [ ] Calendar: add/edit/delete timed and untimed events, month/date navigation.
  Observe start and advance delivery, replacement/cancellation, no duplicates.
- [ ] Tap Calendar notifications warm and after termination: correct live event/day;
  deleted event falls back safely; edited date/title resolves current event. An open
  draft is preserved and target opens only after closing it. Malformed/foreign
  payloads do not navigate; a newer Finance tap supersedes pending Calendar navigation.
- [ ] Journal: create title-less and long text entries, mood/tags, history/search,
  edit/cancel/failed Save without losing text; delete confirmation.
- [ ] Audio: explicit microphone prompt, deny/Settings return, start/stop once,
  preview/play/pause, attach, save, restart/play, missing-file and retry UI.
- [ ] Video: explicit camera/microphone prompts, front camera, flip before recording,
  tap start/tap stop, timer, preview/use/re-record/cancel; restart/play. Background,
  lock/unlock, interruptions and late callbacks must not discard committed media
  or attach an old recording to another entry.
- [ ] Ideas: empty action, category/status, create/read/edit/delete, filters and
  restart. Load failures remain errors and retry does not clear data.
- [ ] Finance: real setup (no seed values), balance/currency, AUTO/MANUAL fixed daily
  allowance, expense/income CRUD, expected income, obligations and completion.
  Expense changes never silently rewrite an existing allowance.
- [ ] Finance notifications: enable explicitly, future delivery, title/date/time edit,
  disable/date removal/complete/delete cancellation, configured future reopen and
  past non-delivery; no money movement. Warm/cold tap opens live obligation or list;
  unsaved sheet survives; deleted/completed targets are handled safely.
- [ ] Permissions: Settings shows granted/denied/not-requested/provisional honestly;
  only explicit Enable prompts, no double Calendar/Finance prompt, Settings return
  refreshes both domains. Native settings launch errors have recovery guidance.
- [ ] Capacity/retry: Calendar + Finance + unknown pending requests share 48 slots.
  Full capacity shows unscheduled state; later free space recovers. Schedule/list/
  registry/cancel failures are visible and never roll back financial data.
- [ ] Cold notification tap during onboarding is deferred until it closes; target
  remains correct and no competing editor modal covers onboarding.
- [ ] Foreground/background, termination/restart and lock/unlock: no duplicate alerts,
  no stale success badges or lost drafts from notification publications.
- [ ] Change local date/timezone where practical: today's Plan/Finance date refreshes;
  saved daily allowances remain fixed; future local reminders reconcile. Exercise
  DST gap (no shifted alert), fold (earlier occurrence) and past (no immediate alert).
- [ ] Every editor (Plan, Calendar, Journal, Idea, Finance/setup): keyboard focus,
  long text/form scrolling, Save/Cancel reachable, notch and home-indicator clearance,
  bottom tabs do not cover controls. Settings/onboarding scroll at large text sizes.
- [ ] VoiceOver: Settings icon, Close/Save, add actions, selected segments, checked
  plans, Finance over-limit text, recorder start/stop and status have useful labels/
  roles. Essential states are understandable without color; 44pt control targets.
- [ ] Privacy copy matches device behavior: local records and local media, no automatic
  upload/transcription, no Telegram dependency; lock-screen title disclosure clear.

## Before App Store submission

- Complete and record real iPhone acceptance above, including local notification
  timing/trigger readback and camera/audio/video behavior in a native build.
- Verify Goals on a real iPhone before describing them in store metadata. Standalone
  Tasks/Assignments are intentionally outside the native product contract.
- Apple Developer enrollment/access, unique iOS bundle identifier, signing,
  provisioning, version/build numbers and a release archive/TestFlight build.
  No EAS project or production signing setup is currently supplied here.
- Replace the bundled Expo template icon (blue Expo mark) with final Workazy branding
  and review splash artwork/dimensions before release. Current assets are not final store art.
- Publish a truthful Privacy Policy URL and support contact/URL. Complete App Store
  privacy declarations, required privacy manifest/SDK disclosures and encryption
  declarations based on the actual release binary and dependency audit.
- Review camera/microphone purpose strings already in app.json and contextual
  notification permission text; ensure release native configuration contains them.
- Prepare actual-device screenshots, localized description/keywords, category,
  age rating, support metadata and reviewer instructions.
- Review local-data loss/backup expectations and OS backup behavior. This mobile
  implementation has no user-facing backup/export or cloud sync. Do not promise
  encryption, retention guarantees or recovery not implemented by the release.
- Audit release dependencies/telemetry and any distribution/update infrastructure
  for privacy declarations. No mobile HTTP reminder/media backend is currently
  wired; a future backend would need a separate privacy and authentication review.

No App Store submission, account, AI, subscription or cloud work is implemented.
