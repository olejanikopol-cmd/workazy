# Slice 4 — Native Records: text Journal + Ideas

Implementation brief for **DeepSeek**, prepared 2026-09-11 after Slice 3 review approval. Implement this slice only, in one autonomous pass; stop before Slice 5. This replaces the completed Calendar brief. The architect changes only this file; product code and migration status are unchanged by preparation.

## Objective, baseline and allowed changes

Build Journal and Ideas inside the existing Records tab. Preserve four tabs, Plans behavior/storage, Calendar CRUD/notifications/lifecycle, theme and route defaults. The root route still redirects to /(tabs)/plans; never restore invalid initialRouteName="plans".

Observed baseline: independent mobile/ package; Expo ~57.0.22, Router ~57.0.21, React 19.2.3, RN 0.86.3; AsyncStorage 2.2.0 and Expo Crypto already installed. Slice 3 re-review passed 130 tests in default/UTC/Kyiv/Los Angeles, typecheck and lint (zero errors, three unused-variable warnings). Native acceptance for Slices 1–3 remains pending. These are baseline results, not Slice 4 results. Root tracked diff contains only the mobile ESLint/TypeScript exclusions; mobile and harness files remain untracked.

Before implementing, record git status and hashes of existing files, including untracked native files. Update mobile/MIGRATION_STATUS.md with decisions, then actual implementation results. Allowed implementation changes: Journal/Ideas types, storage, features and tests under mobile/; mobile/src/features/records/RecordsScreen.tsx and small Records-specific helpers; mobile/README.md and mobile/MIGRATION_STATUS.md. Change the Records route only if wiring requires it. Package/lockfile changes need a concrete reason; no packages are expected. Do not change Plans, Calendar, notification services/tests, global theme/navigation/config, root web/API/DB/worker/Telegram code, or regenerate the scaffold.

## Read and reuse conceptually

Read MASTER_PROMPT.md, HARNESS.md, AGENTS.mobile.md, MOBILE_ARCHITECTURE.md, DESIGN_SYSTEM.md, tasks/mobile-migration.md, this brief, mobile README/status and references. This bounded brief overrides broader instructions to continue the migration.

Inspect these sources before coding:

| Source | Product truth and decision |
| --- | --- |
| lib/types.ts | Mirror JournalEntry, JournalMedia, JournalMediaKind, TranscriptionStatus, Idea, IdeaCategory and IdeaStatus, with provenance comments; no root runtime imports. |
| app/secondary-screens.tsx: JournalScreen, IdeasScreen and label maps | New entry/History, optional title, moods, comma tags, reader/search; live Ideas categories/statuses/filters/defaults. Native editing and confirmation improve browser CRUD safety. |
| app/planner-app.tsx, lib/planner-storage.ts, lib/planner-api.ts | Web state ownership, snapshot/sync are context only. No native import, migration or sync. |
| app/api/v1/journal/route.ts and [id]/route.ts; Ideas equivalents; app/api/v1/state/route.ts; lib/api.ts | Actual trimming, field limits, enums, timestamps and serializers. See deliberate local-body exception below. |
| app/journal-media.tsx, lib/media-recorder.ts, lib/journal-export.ts | Browser recorder, Blob/object-URL drafts, HTML players, download/print/ZIP/transcript tools must NOT be imported. entrySearchText is conceptual search provenance only. |
| lib/journal-media.ts, lib/journal-media-upload.ts, lib/r2.ts, lib/media-sign.ts, lib/media-limits.ts, db/schema.ts | D1 metadata/R2 bytes and association contract for Slice 5; not runtime dependencies here. |
| app/api/v1/journal/[id]/media/route.ts; journal/media/route.ts; media uploads/session/parts/complete/abort, file-url, transcript and delete routes | Entry-before-upload, returned JournalMedia, temporary playback links and remote cleanup semantics. Inspect only. |
| Native RecordsScreen, Screen/AppText/SegmentedControl/theme, Plans/Calendar stores/date validators/sheet guards | Reuse patterns for hydration, immutable state, persist-before-commit, synchronous locks, guarded completion and root-safe navigation. |

No web screens, @/lib/*, db/*, Next/Cloudflare, browser storage or web API client in the mobile runtime. lib/api.ts requires a configured bearer token or trusted authenticated-owner header; a native credential/conflict contract is not established. **No backend sync is authorized.** Never copy secrets, fabricate trusted headers, or show a connected-cloud indicator.

## Domain and text decisions

Mirror existing shapes, not a generic merged Record model:

    type JournalEntry = {
      id: string; date: string; title?: string; body: string;
      mood?: string; tags: string[]; media?: JournalMedia[];
      createdAt?: string; updatedAt?: string;
    };
    type IdeaCategory = 'thought' | 'want' | 'project' | 'purchase' | 'someday';
    type IdeaStatus = 'new' | 'thinking' | 'plan' | 'done' | 'archive';
    type Idea = {
      id: string; title: string; description?: string;
      category: IdeaCategory; status: IdeaStatus;
      createdAt: string; updatedAt: string;
    };

IDs: entry-${Crypto.randomUUID()} and idea-${Crypto.randomUUID()}, injected in tests, generated once per accepted submission after busy/validation gates. ID collisions fail without replacing rows. Edits preserve ID, array position, Journal date and createdAt (including its absence on legacy entries); update updatedAt from the injected clock. New rows use the same canonical UTC instant for both timestamps. Idea timestamps are required. Do not copy the web Ideas UI's date-only todayIso() metadata: use native strict UTC timestamps and the existing Slice 2 validator unchanged.

Journal date is device-local YYYY-MM-DD captured when the editor opens; midnight/tab changes do not move it. No backdate/date-edit UI in this slice. Preserve valid stored dates; use established 0001–9999 validation and full-year-safe display, no year-zero/UTC slicing/constructor remapping.

Input rules (visible errors, never truncating TextInput maxLength):

- Journal title: optional, outer trim, blank -> omitted, max 300 for new/changed values.
- Journal body: outer trim matches web saveEntry; preserve every internal newline, blank line, Unicode/emoji/combining sequence and space without normalization. New text-only entries require nonblank body; title/mood/tags alone cannot create empty rows.
- **Local Journal bodies have no application character cap.** Web editor has no body limit, but POST/PATCH/state APIs cap body at 5,000 characters. Preserve long local entries (test at least 100,000 characters) instead of importing a transport cap. Document that >5,000-character entries are not currently backend-write compatible. Future sync must resolve this explicitly without truncating/replacing local text. Physical storage is finite; write failure retains the draft and committed state.
- Moods exactly: Спокойно, Энергично, Тяжело, Радостно. Default unset; selected chip toggles off. Storage mood remains optional string, not enum. Display and preserve unknown stored mood unless explicitly changed/cleared; no new free-form mood editor. API limit is 60 characters for changed values.
- Tags: comma-separated input, trim each token, omit empties; preserve case/order/duplicates. Existing API uses 20 tags and 40 characters each; reject exceeding these input limits visibly rather than copying readTags' silent slice(0, 20). Preserve untouched stored tags exactly on unrelated edits, including legacy long arrays and tags containing commas; do not join/reparse unless tags were edited. Dirty detection includes raw tag input.
- Ideas: nonblank outer-trimmed title max 300; optional outer-trimmed description max 2,000 for new/changed values, matching API limits. Blank description -> omitted; keep internal multiline/Unicode unchanged.
- Snapshot parsing is structural, never input normalization. Load/read valid legacy longer text, unfamiliar moods and optional empty strings without trimming or rewriting. Unchanged legacy fields may survive unrelated edits; changed overlength fields produce errors without draft loss. Preserve absent optional fields versus present values when untouched.
- Empty Journal bodies remain loadable for legacy/media compatibility. Editing cannot clear a text-only body. Existing media-bearing entries may retain empty body; do not fabricate media to bypass validation.

## Records, Journal and Ideas UX

Keep Дневник / Идеи segmented navigation reachable. Own segment, Journal mode/search, Ideas filters and sheet identity above conditional feature rendering so session selections survive switching. Process restart defaults to Journal/New entry; domain persistence is separate from UI preferences. No new main tabs.

Journal:

1. Новая запись / История modes, default New entry. New-entry panel shows today's date and a real compose action opening a full-screen native editor. Do not auto-open a modal on focus; capture date at open.
2. History is a FlatList with date, optional title (display fallback only), body preview, mood/tags. Open reader by ID from current committed store. Full body scrolls and is selectable, never reconstructed from a preview. Older entries remain reachable; no 50-entry server-list cutoff.
3. Derive history order: date descending, createdAt descending (missing after present for same date), original stored index for ties. New rows prepend, edits preserve stored position/createdAt; updatedAt does not reorder History. Sorting never rewrites storage.
4. Simple local case-insensitive search across title/body/mood/tags and existing media transcripts, conceptually matching web search. Distinguish empty history from no matches. No remote search.
5. Successful create closes its own editor and reveals History/new entry, clearing search. Successful edit returns to the saved entry's reader and clears search only if needed to reveal it. Confirm delete natively; after durable removal close only that entry's sheet and leave History usable. Failed writes retain reader/editor and full draft.

Ideas preserve the live values:

| Category | Label | Status | Label |
| --- | --- | --- | --- |
| thought | Мысль | new | Новая |
| want | Хочуха | thinking | Думаю |
| project | Проект | plan | В план |
| purchase | Покупка | done | Сделано |
| someday | Когда-нибудь | archive | Архив |

Create/read/edit/delete title, description, category/status; defaults thought/new. Both category and status filters include UI-only Все, combined with AND; tapping selected filter returns to All. Never persist all. Status plan does not create PlanTask/Goal; archive remains stored/reachable. Use stored order (new prepend; edits/status retain position), matching the web client rather than inconsistent API filtered/unfiltered sorting. Successful add/edit reveals the saved Idea and clears only excluding filters. Long title/description remain readable. No fake seeded ideas.

Each domain has independent loading, load-error + Retry, ready-empty, filtered-empty and write-error states. Corrupt Journal must not block Ideas or navigation. Focus never reloads disk over current state. Full-screen editors block tab/segment switching until save/guarded dismissal; background/foreground preserves drafts. UI selections persist across tab switches. Unsaved drafts need not survive process termination: document this; no autosave infrastructure.

## Editor and async safety

Use native full-screen Modal, own SafeAreaView, keyboard avoidance, explicit Save/Cancel outside scrolling fields. Compact/notched phones, Dynamic Type, Russian accessibility labels and 44pt targets. Existing tokens only. One list-level vertical scroll owner; remove the outer Records ScrollView when rendering FlatLists. For very long body use a bounded scroll-enabled multiline TextInput with reachable caret/selection and metadata fields, not an unbounded 100k-character native layout. Validate keyboard/input scrolling on device when available; otherwise pending.

A production-used synchronous sheet lock covers save AND delete before any await, with finally release. While busy disable fields/actions/pickers and all dismissal paths. Store has its own synchronous write gate; overlapping operations return typed busy with no side effects. Capture target ID, sheet key and draft revision, including delete/discard confirmation callbacks. Only the current sheet/revision can close, reveal, clear draft/search or redirect. Update current identity synchronously on open/replace/close; do not rely solely on a passive effect updating a ref. Missing IDs cannot mutate another row.

Dirty detection covers all Journal title/body/mood/raw-tags and Idea title/description/category/status fields against the captured initial draft. Cancel/Android back/gesture dismissal confirm dirty discard; disable unguarded swipes. Delayed confirmation must not discard a newer editor or bypass its lock. No optimistic draft reset, React updater side effects, background autosave or stale closure completion.

## Persistence and modules

Two independent AsyncStorage envelopes:

    // workazy-native-journal-v1
    type JournalSnapshotV1 = { version: 1; entries: JournalEntry[]; savedAt: string };
    // workazy-native-ideas-v1
    type IdeasSnapshotV1 = { version: 1; ideas: Idea[]; savedAt: string };

Create src/types/journal.ts and idea.ts; src/storage/journalStorage.ts and ideaStorage.ts; src/features/journal/ and ideas/ with pure model/selectors, injected store factory, singleton native binding, workspace/row/reader/editor components. Put new shared sheet policy under src/features/records/ if useful; do not generalize Calendar by editing it. Only bindings import AsyncStorage/Crypto. No new state framework, database or generic domain engine.

Stores expose cached immutable snapshots through useSyncExternalStore, phase/saving/errors, subscribe/load/retryLoad/add/edit/remove. Inject key/value storage, clock, IDs. Hydration coalesces and is idempotent; mutations/writes blocked until ready. Missing key -> ready empty. Malformed JSON/version/row/date/timestamp, duplicate/empty IDs, bad arrays/types or unknown Idea enums -> load-error, original bytes untouched, mutations blocked. Retry rereads failed store only. No reset, silent repair/drop/trim of rows. Copy/freeze nested tags/media so subscribers cannot mutate committed state.

One synchronous lock per store covers every envelope write. Compute next state, await full persistence, then publish. Failure leaves committed data/bytes unchanged and full draft retryable. No global AsyncStorage clear, Plan/Calendar key access, cross-domain writes, retention cap, effect autosave or data seeding. Keep savedAt and metadata strictly canonical UTC; dates local.

## Slice 5 compatibility: metadata only now

Mirror every JournalMedia field in lib/types.ts: id/journalEntryId, audio/video type, mimeType, optional originalFilename, sizeBytes, optional durationMs/width/height, transcript, transcriptEdited, transcriptionStatus (pending/processing/ready/error), optional transcriptionError/provider, createdAt/updatedAt. Validate types/enums, finite nonnegative size, positive optional duration/dimensions, canonical timestamps, unique media IDs and association to the parent entry.

Support absent media and media: []; new text entries omit it. Text edits preserve existing metadata/transcripts exactly. Load metadata-only legacy entries; show a plain attachments-unavailable note if needed, not fake players or recording/upload actions. Reject unknown attachment properties carrying bytes (Blob/File/ArrayBuffer/byte arrays/base64/data URLs/file or temporary playback URI fields); use an explicit metadata schema. Do not reject legitimate journal prose/transcripts merely because they contain a data-URL-like string. Malformed metadata makes the whole snapshot load-error without rewriting it.

Slice 5 can attach returned JournalMedia[] to an existing entry ID with a narrow mutation under the same store lock, without replacing this envelope or text CRUD. Do not implement upload/attachment mutations now. Temporary capture files and upload progress will be separate from durable JournalEntry JSON.

Backend findings: metadata in D1, binary streams in R2; entry must exist before upload. Multipart upload and chunked upload-session/part/complete/abort routes exist; the current web client uses chunked sessions. Playback URLs are separate and temporary; transcript PATCH/transcribe and media/entry DELETE have remote side effects. Slice 5 must audit native credentials, local/server IDs, the 5,000-character body mismatch and retry/cancel/cleanup before integration. Local text commits independently of media success. Slice 4 deletion is local only, even for stored attachment metadata; never claim it deletes R2 objects. Failed deletion retains metadata.

Excluded: audio/video recording, camera/mic permissions, upload, transcription execution/editing, R2/D1 wiring, playback, sync/auth, export/import/backup, Records reminders, Finance, Goals and AI. **Omit media buttons** in Slice 4; no fake affordances, reconnect banners, media packages/plugins/permission strings. Prepare via types/storage only.

## Required tests

Exercise production-used models/stores/controllers, not unused helper copies. Keep existing Plan/Calendar tests passing and unchanged. Add journal-*.test.mjs, idea-*.test.mjs and records-sheet-*.test.mjs as needed:

1. Actual store -> serialized bytes -> brand-new store round-trip for each domain, independent keys, no seeds/Plan/Calendar writes. Optional title/metadata absence, mood/tags and every category/status survive restart.
2. Bad JSON/version/rows/enums/dates/timestamps/duplicate IDs/media -> load-error, unchanged bytes, zero writes. Retry; deferred/coalesced hydration; pre-ready mutation rejection; no stale hydration overwrite.
3. Deferred/failed add/edit/delete/status writes: synchronous busy rejection, committed state unchanged, draft intact, finally unlock, retry without duplicates. IDs once per accepted submission; edit identity/date/createdAt/order preserved.
4. At least 100k characters of Cyrillic/emoji/combining characters/blank lines/internal spacing: input -> save -> restart -> unrelated edit -> restart retains exact body except defined outer trim. Optional title, empty-body validation, visible field-limit errors and legacy long-field/tag preservation.
5. History sorting/ties/missing createdAt/search/open by ID; Ideas filters/status/archive/order/reveal. Captured date across midnight, strict UTC DST-gap timestamp acceptance and impossible timestamp rejection under all timezone runs.
6. Every-field dirty detection; save/delete share production lock through persistence; duplicate submit/dismissal blocked. Deferred save/delete/discard from A cannot close/redirect/clear B. Test the actual completion policy used by the parent and inspect component wiring.
7. Absent/empty/present media metadata round-trips and survives text edits/failed delete; metadata-only rows readable. Invalid byte-bearing metadata rejected without rewriting; prose resembling base64 remains valid. Never fabricate media.
8. Import/runtime audit excludes browser/backend/Telegram/media dependencies and permissions/fake sync UI. Pure tests do not prove native keyboard/scroll/VoiceOver behavior.

## Verification and handoff

From mobile/, record each actual command/result:

    npm test
    TZ=Europe/Kyiv npm test
    TZ=America/Los_Angeles npm test
    TZ=UTC npm test
    npm run typecheck
    npm run lint
    npx expo install --check
    npx expo-doctor
    npm run export:ios

From root: npm run build; git diff --check; final status/diff and baseline hash comparison of forbidden files (git diff misses untracked mobile sources). Runtime leakage scan:

    rg -n 'telegram|TELEGRAM_|localStorage|window\.|document\.|navigator\.|MediaRecorder|next/|cloudflare:|@/lib/|fetch\(|axios|expo-camera|expo-audio|expo-av' mobile/app mobile/src

Inspect matches as runtime versus comments; inspect new imports, package/app config for HTTP, secrets, permissions, backend and binary media handling. Do not suppress failures/change unrelated root code. The root Telegram workflow test assertion is pre-existing, not permission to fix it. Dependencies are installed; do not upgrade Expo. Report any network/doctor/build/export blocker precisely.

Native acceptance when available: cold launch Plans/four tabs, Plans/Calendar smoke regression; Records sections; long reader/editor with keyboard, caret/selection at end, large text/VoiceOver/44pt/safe areas; titleless entry/mood/tags/history/edit/delete; Idea filters/status; dirty cancel/back; background/foreground; offline restart after confirmed save; failed-write retry without text loss. Records must cause no media/notification permission prompt.

No Xcode/iPhone evidence exists here: mark Slice 4 keyboard/visual/native restart/accessibility acceptance pending, preserve previous slices' pending acceptance, and never call tests/export/simulated timings device evidence.

Final implementer report: exact files, working flows, storage/text/order/media decisions, production-path coverage, commands/results, unchanged Slice 1–3 evidence and device status. Update native README/status with only delivered Slice 4, local-only data/body/API mismatch, unsaved-draft termination limitation and deferred Slice 5. Stop; do not mark the migration complete or begin recording.
