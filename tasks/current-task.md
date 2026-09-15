# Final mobile completion fix — Goals

Prepared and implemented 2026-09-14 against the completed Slice 7 working tree.
This is the final bounded migration fix, not a new broad slice. Native/iPhone
acceptance remains PENDING until observed on a simulator or physical device.

## Final product decision

- Native Plans navigation is exactly **План | Цели**.
- Standalone Tasks/Assignments are intentionally outside the native Workazy product.
- Legacy web/backend `Assignment` types and data remain intact. There is no destructive
  migration and no browser-to-native import.

## Goals architecture

- The native `Goal` keeps the useful web fields: stable id, title, optional
  description, week/month/year period, required deadline, explicit integer progress,
  completion and created/updated timestamps.
- Native V1 adds immutable `periodKey`: local Monday `YYYY-MM-DD` for a week,
  `YYYY-MM` for a month and `YYYY` for a year. Calendar arithmetic uses local dates,
  including year 1–99 handling, and never elapsed milliseconds or a fixed offset.
- Goals use the independent AsyncStorage key `workazy-native-goals-v1`, strict V1
  parsing, a revision gate, stable Expo Crypto IDs, persist-before-publish writes and
  frozen published snapshots. Corrupt bytes produce load-error and remain untouched;
  a failed save retains the committed state and visible draft.
- Completing sets progress to 100. Reopening a completed goal explicitly resets it
  to 0, which is stated on the action. Setting progress to 100 completes the goal;
  any lower valid integer is active progress.
- Goals supports current/all period views, a completed visibility control, long-text
  read/edit, safe delete and keyboard-safe full-screen editing. No records are seeded.

## Protected scope

Daily Plan, Calendar and its notification routing, Journal/media, Ideas, Finance and
its notifications, shared notification capacity, onboarding and Settings retain their
existing implementations. No Finance/notification architecture, package, native
configuration, root web/backend runtime or legacy data contract changes are part of
this fix.

## Verification

Production-path Goals tests cover empty startup, week/month/year creation, exact
restart, edit, progress, complete/reopen, delete, stale mutations, failed writes,
corrupt storage, local calendar boundaries, no fake data and final Plan | Goals
navigation. Full command results are recorded in `mobile/MIGRATION_STATUS.md`.
