# Slice 5 — Native Journal audio/video, local files and playback

Implementation brief, prepared 2026-09-11. Implement **Slice 5 only** and stop before Slice 6. This brief overrides the broader harness instruction to continue the migration. Preparation changes only this file; it does not implement media or update product status.

## Decision and inspected baseline

Deliver real native recording, preview, re-recording, multiple attachments, durable local media and playback inside Journal. **Choose the bounded local-media branch. No cloud upload, sync, remote playback or transcription execution in this slice.** This is a functioning offline media implementation, not upload placeholders.

Current baseline is commit `1fc38ae` (`mobile: complete slice 4 journal and ideas`), following `7bca37e` for Slices 1–3. Working tree was clean before this brief. Preparation reran the mobile suite: 223 tests passed. Migration status reports 223 tests in default/UTC/Kyiv/Los Angeles, typecheck, app lint with zero problems, full ESLint with three pre-existing Calendar test warnings, dependency/doctor/export/build checks. Those reported checks are baseline evidence, not Slice 5 results. Native acceptance for all prior slices remains pending.

Inspect and preserve the final Slice 4 fixes: per-field `changed` flags; unchanged legacy text/optional values/tags/media; strict parser before every write; persist-before-commit and synchronous store gate; deep-frozen rows AND snapshot wrappers; synchronous parent `commitSheet`; keyed close/reveal and delayed-confirmation identity/revision/busy checks; Records dates 0001–9999 with nullable unsupported conversions. No independent Slice 4 redesign.

Read `MASTER_PROMPT.md`, `HARNESS.md`, `AGENTS.mobile.md`, `MOBILE_ARCHITECTURE.md`, `DESIGN_SYSTEM.md`, `tasks/mobile-migration.md`, mobile README/status, this brief and relevant `/references`. Record implementation decisions and then actual results in mobile status. Save initial status and protected-file hashes before editing.

## Repository findings and backend boundary

These are source findings, not evidence that a deployed service or credentials were tested:

| Source | Existing contract / consequence |
| --- | --- |
| `lib/types.ts`, native `src/types/journal.ts`, `src/storage/journalStorage.ts` | JournalEntry has optional `media: JournalMedia[]`; multiple attachments supported. Metadata has ID/parent/type/MIME/name/size/duration/dimensions/transcript/status/timestamps, no binary or playback URI. Native parser rejects unknown media keys and duplicate media IDs across entries. Keep it strict. |
| `app/journal-media.tsx`, `lib/media-recorder.ts` | Browser MediaRecorder, Blob/object-URL drafts, players and transcript controls are conceptual references only. Do not import their runtime or copy the misleading waiting-for-cloud UI. |
| `lib/media-limits.ts` | Audio: 900,000 ms and 25,165,824 bytes (15 minutes / 24 MiB). Video: 600,000 ms and 83,886,080 bytes (10 minutes / 80 MiB). Existing targets: video 900,000 bit/s, audio 96,000 bit/s. These are per-file limits, not decimal MB or aggregate entry limits. |
| `lib/api.ts`, `lib/planner-api.ts` | Server requires `Authorization: Bearer <WORKAZY_API_TOKEN>` or an infrastructure-authenticated owner header. Mobile has no API base URL/credential acquisition/storage contract or trusted owner identity. Never fabricate `oai-authenticated-user-email`, embed the server token in a bundle/EXPO_PUBLIC variable, or read/copy secrets into mobile. |
| `app/api/v1/journal/route.ts`, `[id]/route.ts`, `state/route.ts` | Server Journal body cap is 5,000 characters; local bodies intentionally exceed 100k. Native IDs are not evidence that corresponding D1 entries exist. Do not truncate local text or create hidden partial server entries just to enable media. |
| `lib/journal-media.ts`, `lib/r2.ts`, `db/schema.ts`, `.openai/hosting.json` | D1 `DB` stores metadata; private R2 `MEDIA` stores streams under `journal-media/`. Entry must exist before upload. No direct mobile R2 credentials. |
| `lib/journal-media-upload.ts`, `lib/media-upload.ts`, media upload routes | Chunk sessions, exact part sizes, MIME signature checking, stream assembly, retry/abort and idempotent completion exist. Reuse this protocol in a later authenticated integration; no parallel backend needed. |
| `lib/media-sign.ts`, media `file-url` / `file` routes | Authenticated URL request returns a relative signed playback URL with five-minute TTL. File route supports Range and bearer/signature authentication; missing objects return 410. URLs are temporary, never durable JournalMedia fields. |
| `lib/transcription/provider.ts`, `groq.ts`, `lib/journal-media.ts` | Groq Whisper (`whisper-large-v3-turbo`), server-only `GROQ_API_KEY`, 60-second provider timeout. Video transcription requires a separate audio track; backend refuses to send the full video. No bounded native extraction/auth contract exists. Defer execution, transcript editing, retry and extraction. Preserve/display existing transcripts read-only. |

### Upload protocol reserved for later work — do not implement it now

All JSON routes use `{ ok: true, data }` / `{ ok: false, error }` envelopes. The compatible future flow is:

1. Establish authorized native API configuration, safe credentials and local/server entry identity/conflict policy, resolving the 5,000-character mismatch first. Validate file size/duration/MIME locally; stream/chunk file data, never base64 or load a whole video into JS.
2. `POST /api/v1/journal/media/uploads` with `{ journalEntryId, type, file: { sizeBytes, mimeType, fileName }, durationMs?, width?, height?, audioTrack? }`. Returns `{ id, chunkSizeBytes, main: { partCount, sizeBytes }, track: ... | null }`; current chunk size is 512 KiB. IDs are server-assigned media IDs.
3. `PUT /api/v1/journal/media/uploads/:id/parts/:kind/:part`, zero-based `part`, kind `main`/`track`, exact binary part bytes (`application/octet-stream`). `GET /uploads/:id` returns uploaded main/track part numbers. Server validates lengths and the first part's container signature. Existing web retry policy is three attempts for network/408/429/5xx; a future native adapter needs explicit abortable request deadlines, not unbounded waits.
4. `POST /uploads/:id/complete` assembles bounded R2 streams, inserts D1 metadata and returns JournalMedia; repeated completion returns the existing row. On an ambiguous timeout, check/retry the same session/completion before creating duplicates. Merge returned metadata by the correct entry/media identity under the local store gate, never overwrite text with a stale server snapshot.
5. `DELETE /uploads/:id` aborts temporary manifest/chunks (missing manifest is idempotent). Manifests expire after 24 hours, with cleanup on access; this is not a proven scheduled garbage collector. Completion failure retains chunks for retry and attempts final-object cleanup; cleanup failures are possible. Preserve the local file on any upload/auth/network failure.
6. Legacy `POST /api/v1/journal/media` multipart also exists (`journalEntryId`, `type`, `file`, optional `audioTrack`/duration/dimensions). Prefer chunking for later mobile because it avoids large proxy requests. `GET /journal/:id/media` and `GET /journal/media/:id` return metadata.
7. Remote `DELETE /journal/media/:id` deletes R2 objects before D1 metadata; entry deletion also removes media. Never claim local deletion invokes this. `PATCH /journal/media/:id` edits transcript (20,000-character input cap); `POST /:id/transcribe` invokes the server provider and may return metadata with error status while preserving the file.

No HTTP adapter, upload queue, auth screen, fake percentages, cloud-connected badge or inert upload/transcribe button in Slice 5. Define a narrow repository boundary that can later resolve a remote media item; implement only local resolution now. Existing remote metadata without a local file remains visible and honestly unavailable for playback.

## Packages and native configuration

Use SDK-compatible packages, not `expo-av` or browser fallbacks. The installed `mobile/node_modules/expo/bundledNativeModules.json` for Expo `~57.0.22` specifies:

| Package | Compatible range | Purpose |
| --- | --- | --- |
| `expo-audio` | `~57.0.5` | Native microphone recording and audio playback |
| `expo-camera` | `~57.0.5` | CameraView and native video recording |
| `expo-video` | `~57.0.4` | Video preview/playback and loaded duration metadata |
| `expo-file-system` | `~57.0.7` | App-owned files, stat/copy/move/delete/list; already transitive, make direct |

Run from `mobile/`: `npx expo install expo-audio expo-camera expo-video expo-file-system`. Change only mobile package/lockfile; do not upgrade Expo/RN or add media-library, image-picker, FFmpeg, network/auth or state-management dependencies. Confirm the installed typings/plugin options before coding; no invented API names or web shims.

Append these entries to existing `expo.plugins` in `mobile/app.json`, retaining every current plugin:

```json
[
  ["expo-audio", {
    "microphonePermission": "Workazy использует микрофон для аудио- и видеозаписей дневника.",
    "recordAudioAndroid": true,
    "enableBackgroundPlayback": false,
    "enableBackgroundRecording": false
  }],
  ["expo-camera", {
    "cameraPermission": "Workazy использует камеру для видеозаписей дневника.",
    "microphonePermission": "Workazy использует микрофон для аудио- и видеозаписей дневника.",
    "recordAudioAndroid": true,
    "barcodeScannerEnabled": false
  }],
  ["expo-video", {
    "supportsBackgroundPlayback": false,
    "supportsPictureInPicture": false
  }]
]
```

Both microphone strings must match. Keep `orientation: "portrait"`, four tabs, startup route and notification settings unchanged. No Photos/gallery permission, file sharing, opening Documents in place, background modes/services, remote push or additional notification prompts. `expo-file-system` needs no added plugin for private sandbox files; keep iOS file sharing disabled. Audit generated/resolved permissions (including transitive Android storage permissions); do not request external-storage permission for private files. Do not run a destructive prebuild or commit generated native projects. Config-plugin changes need a new native binary for acceptance.

Verified SDK 57 references: [Audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/), [Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/), [Video](https://docs.expo.dev/versions/v57.0.0/sdk/video/). File API/plugin evidence is available in installed `expo-file-system/src` and `plugin/src/withFileSystem.ts`.

Use audio `prepareToRecordAsync`, `record({ forDuration: 900 })`, awaited `stop`, recorder status and native URI; use `useAudioPlayer` for playback. Start from the AAC/M4A high-quality preset, override audio bitrate to 96,000 and use mono for voice. Configure recording mode only for the active owner, then restore playback mode (`allowsRecording: false`); background recording/playback remains disabled. The default output is cache, so it must be adopted into owned storage before becoming durable. [Audio API](https://docs.expo.dev/versions/v57.0.0/sdk/audio/)

Use CameraView in video mode, facing front initially, 720p target and 900,000 video bit/s. Pass `maxDuration: 600`, `maxFileSize: 83886080`; specify a supported iOS codec (prefer H.264) when setting bitrate. `recordAsync` resolves when recording ends, not when it starts: retain that promise and handle `stopRecording` separately. The result can be undefined. Camera flip stops recording, so enable flip only in idle/ready; disabled while starting/recording/stopping, available again after re-record. No seamless in-take camera-switch claim. [Camera API](https://docs.expo.dev/versions/v57.0.0/sdk/camera/)

Use `useVideoPlayer`/`VideoView` for local preview with native controls, background/PiP disabled; release players when leaving. [Video API](https://docs.expo.dev/versions/v57.0.0/sdk/video/)

## Native UX and recorder state machine

JournalSheet gets real «Аудио» / «Видео» actions in add/edit mode; reader has playback and an Edit entry action for adding more. Preserve the existing text draft when entering/exiting recording. Dedicated full-screen video surface: black camera canvas, safe areas, front camera, large record/stop control, timer, Close and Flip; no press-and-hold. Audio has equally explicit start/stop, timer, cancel, preview and re-record.

Host dedicated recorder/preview components within the existing full-screen JournalSheet modal, keeping its editor state mounted/owned above them. This is an intentional bounded alternative to adding a Router recorder route: avoid stacked competing native modals, route-parameter callbacks/URIs and changing root navigation. The recorder is full screen, not a small camera embedded among text inputs.

Implement one production-used controller per recording session, with injected native recorder, permission, clock and file ports. Suggested explicit states:

`idle -> requesting-permission -> preparing -> ready -> starting -> recording -> stopping -> validating-file -> preview -> adopting -> attached`

Also `denied`, `error`, `cancelling`, `cancelled`. Audio's initiating record tap may continue through granted permission/preparation into recording for the same active session; video action opens the permission/ready camera, then one record tap starts. The same record control's next tap stops. No hold gestures, double-tap requirements, hidden automatic recording on Journal focus, or fake JS-only recording state.

- Acquire a synchronous transition gate before permission/prepare/start/stop awaits. One active native capture/audio-session owner globally; no simultaneous audio recorder and video microphone. Duplicate start/stop and timer/native auto-stop races settle at most once.
- Do not hold a transition mutex waiting for the entire video recording promise: the stop control must remain operable. Track operation generation separately from short start/stop gates.
- Timer uses native elapsed status where available and a monotonic clock fallback for display, never wall-clock timestamps as elapsed duration or a counter of interval ticks. Native auto-stop plus a controller deadline enforces the duration limit. Final recorded duration comes from native status/loaded media, not just the UI timer; unknown/nonfinite/zero metadata is an error, not fabricated success.
- Read actual file size after finalization and again before promotion. Reject zero bytes, nonfinite sizes, unsupported MIME, duration or size above the exact limits. Camera native file-size limit is a guard, not proof; audio polling may stop early if file size is available. No claimed hard audio byte cutoff if native API lacks it: final stat is authoritative. Never truncate, rename to a false MIME or silently save an oversized file. Show a useful error and re-record/cancel actions.
- Match actual container/extension (AAC M4A `audio/mp4`; native video may be MP4 or MOV `video/quicktime`). Inspect a bounded header where needed, not whole-file JS reads. Preserve actual dimensions if available; don't invent them. No transcoding/extraction or second video audio-track recorder.
- Preview is explicit; Use audio/video adds the validated file to the current editor draft, not immediately to cloud. Re-record discards only this uncommitted take after confirmation, releases its player, cleans it and returns to ready (video flip available). It does not replace/delete a previously committed attachment.
- Cancel is available during permission, preparing, recording and preview. Invalidate session synchronously, stop/finalize if needed, release camera/microphone/player, clean only owned uncommitted files and return to the same draft. If a URI arrives after cancellation, clean that old session's file rather than attaching it. Catch all late promise rejections.
- Initialize lifecycle state from `AppState.currentState`. Never start capture while inactive/background. Permission-dialog inactivity must not trigger a start in the background. On genuine capture interruption/background/lock, stop once and retain a valid partial take for explicit preview on return; otherwise show interrupted/error. Never auto-resume recording. Stop playback on background and release hardware on unmount. No guarantee that an in-progress recording survives process death.

## Permission policy

No camera/microphone requests on app launch, Journal mount, History, playback or tab focus. Request only after the user's Audio/Video action (or explicit retry). Audio needs microphone only; video needs both camera and microphone, sequentially with session checks after each await. Do not start silent video when microphone is denied.

Handle unknown/loading, granted, denied-but-requestable, denied/restricted/non-requestable, unavailable camera and native exceptions. Re-request only on explicit retry while `canAskAgain`; otherwise provide Russian explanation, «Открыть настройки» via Linking.openSettings and Cancel. On return from Settings, refresh permission state for the current session without prompting or automatically recording. A stale granted result cannot revive a cancelled recorder or overwrite newer error/permission state. No crash or infinite prompt loop.

## Storage, metadata and local file ownership

Keep `workazy-native-journal-v1`, its V1 envelope and the existing JournalMedia shape. Keep Ideas entirely unchanged. No binary/base64/Blob/byte arrays or file/temporary playback URI in journal snapshots. Data-URL-like prose/transcript text must remain valid. No destructive schema migration or relaxed media parser.

New local attachments use collision-checked `local-media-${Crypto.randomUUID()}` IDs. Persist the full compatible JournalMedia metadata, with the actual parent entry ID, MIME/size/duration, canonical UTC timestamps and optional real dimensions/name. Set `transcriptEdited: false`, `transcriptionStatus: "pending"` meaning not transcribed (as in the current web model); omit transcript/provider/error. This must NEVER show a processing spinner, scheduled transcription promise or cloud queue. Render local availability separately; show «На устройстве» and, where relevant, «Расшифровка пока недоступна». Preserve all existing metadata/status/transcripts without reinterpretation or normalization.

### Repository contract and files

Use `src/services/media/` with these bounded responsibilities (equivalent small file splits are fine):

- `mediaLimits.ts`: native-safe constants/MIME mapping mirrored with provenance from `lib/media-limits.ts`.
- `mediaContracts.ts`: recorder results, draft/prepared attachment DTOs, ownership/session tokens, typed file/permission/capture/playback failures; no Expo imports in the pure contract.
- `recorderController.ts`: production transition/lifecycle/permission/timer policy; adapters translate native events into this controller.
- `localMediaRepository.ts`: injected file port; adopt, prepare, resolve, discard and reconcile owned files; cached immutable status if subscribed.
- `expoMediaFiles.ts`, native recorder/player bindings: only these use Expo modules. Use current `File`, `Directory`, `Paths` APIs. No deprecated-method workaround via web APIs.
- `journalMediaCoordinator.ts`: actual save/delete orchestration, leases, synchronous operation gate, latest journal references and cleanup ordering.
- `src/storage/localMediaManifest.ts`: strict V1 filesystem manifest parser/serializer. It is an ownership record, not another journal store.
- `src/features/journal/media/`: audio/video recorder surfaces, preview and attachment cards/players. Wire the real controller/repository; don't leave tested helpers unused.

Conceptual repository operations:

```ts
adoptCapture(result, owner): Promise<LocalMediaDraft>
prepare(draft, owner): Promise<PreparedLocalMedia>
resolve(media): Promise<LocalPlaybackSource | MissingOrUnavailable>
discard(draft, owner): Promise<CleanupResult>
reconcile(committedReferences, activeLeases): Promise<CleanupResult>
```

`LocalMediaDraft` is in-memory file reference + metadata, keyed to sheet/session/generation. `PreparedLocalMedia` supplies metadata only to the journal store; the filesystem locator stays in the repository. Playback source URIs are ephemeral runtime values. No HTTP implementation now; a future repository can return a remote source without changing JournalMedia or journal persistence.

Use a dedicated sandbox namespace:

- Staging: `Paths.cache/workazy-journal-media/v1/staging/<session-id>/…`.
- Durable: `Paths.document/workazy-journal-media/v1/objects/<local-media-id>/manifest.json` and `recording.<actual-extension>`.
- Manifest V1: `{ version: 1, mediaId, fileName, mimeType, sizeBytes, durationMs, createdAt }`, only strict validated scalars. `fileName` is the single generated relative basename, never arbitrary path input; derive absolute locations from the current sandbox root. No stored absolute container path, which can change between installations/restores. Reject traversal, separators in IDs/basenames, malformed manifests and unexpected file types. No recursively deleting arbitrary URIs or files based only on an ID prefix.

Create a unique destination without overwrite. Native output starts in the app sandbox; adopt the returned file into the owned staging namespace, retaining a lease until its lifecycle ends. Prepare makes a verified complete durable copy/move plus valid ownership manifest before metadata can reference it. Use temporary names and final moves where supported; never claim cross-filesystem or AsyncStorage/filesystem atomicity. Do not remove the only valid source before the destination is complete. Handle disk full/read-only/missing source/stat/copy/move/manifest errors visibly, preserving retryable drafts where possible.

A valid manifest and contained generated path establish ownership. Unknown/unowned/remote metadata never authorizes file deletion. Stored references are authoritative for retention; a prefix alone never means a file is orphaned. A missing/invalid manifest or missing file yields unavailable/error with retry and metadata retained, not a fabricated playable item or automatic metadata deletion.

## Journal transaction and editor integration

Extend Journal model/store narrowly for metadata mutations. Preserve old text-only APIs/tests. Add an atomic `addWithMedia(input, date, preparedMetadata)` and `editWithMedia(id, input, { add, removeIds })` path, plus attachment-only removal if needed for reader actions. New metadata DTOs omit `journalEntryId`; the store supplies the newly generated or existing entry ID. No file ports in the pure journal store.

- New entry Save commits text and all selected prepared media in ONE journal envelope. Permit a media-only new entry when it contains at least one real prepared attachment; text-only blank submissions remain invalid. Generate/check entry ID once per accepted attempt after input gates. No placeholder persisted entry to begin recording, no fake text to satisfy validation.
- Existing entry edit merges attachment additions/removals into the latest committed row under the existing synchronous store gate. Do not replace `media[]` from a stale editor snapshot. Reject duplicate media IDs globally and wrong/missing targets; preserve unrelated media, all untouched text fields, createdAt, captured date and order. Multiple attachments remain possible; no invented single-attachment cap. Update updatedAt only for actual mutations.
- Draft removals/additions are part of dirty detection and draft revision. In edit mode, removal is confirmed and staged until Save; Cancel restores committed metadata/files. In reader mode, confirmed attachment deletion may commit immediately and leave the reader open. Removing the last attachment may leave an empty legacy-compatible entry; never silently delete the parent or invent body text. New/changed text-only body validation otherwise remains intact.
- A coordinator operation owns file leases and the editor busy lock from preparation through journal persistence. Before each awaited result changes a draft, before calling the store, and before closing/revealing, check `{ sheetKey, entryId or new-draft key, draftRevision, recorderSessionId, generation }` against the synchronous current owner. Store still has its own gate. Recheck current state after file preparation; never replay a saved stale row.
- Record/preview sessions hold a parent dismissal/save/delete gate while their surface is active, with their own explicit cancel path. Do not make stop/cancel require re-acquiring a lock held for the entire session. Media Use increments the same draft revision synchronously, transfers its lease to that draft and returns to editing. Text is never reconstructed from previews or overwritten on recorder return.
- Existing delayed discard/delete confirmations must recheck current identity, full draft revision (media included) and busy state. Old recorder/permission/file/player completions cannot attach to, clear, close or redirect a newer editor. If metadata persistence was already in flight when a sheet was superseded, let its original entry commit settle, suppress stale UI effects and retain any file that became referenced; never delete it merely because its old UI owner disappeared.

### Required commit/cleanup order

| Event | Required ordering and failure result |
| --- | --- |
| Use take in editor | Validate/adopt under its session, append staged draft reference only to current owner; no journal write yet. |
| Save with additions | Hold leases -> prepare/verify all final files/manifests -> recheck owner/latest state -> serialize/parse exact next journal bytes -> await AsyncStorage -> publish -> release committed leases. Only then report saved. |
| Metadata save fails | Previous journal bytes/state and committed files unchanged; full text/media draft and prepared file retained for retry. Retry reuses the same take IDs/prepared files without duplicates. Do not release into cleanup while the draft still needs them. |
| Cancel or re-record uncommitted take | Stop and await capture settlement -> stop/release preview -> invalidate/retire lease -> delete only that take's owned staging/prepared files after checking no committed reference; errors are reported/retryable. Late output follows the same cleanup path. |
| Save removing media / reader attachment delete | Confirm correct target -> persist metadata removal first -> only on success stop/release its playback and remove owned file/manifest. Failed persistence leaves the playable committed attachment intact. |
| Delete whole journal entry | Capture its current media IDs -> durable store.remove -> cleanup only now-unreferenced locally owned media; remote files untouched. Failed entry deletion deletes no files. |
| Cleanup fails after successful metadata removal | Keep removal committed, show a cleanup warning and retry; do not report the metadata save as failed, restore a ghost row or lose track of cleanup work. Ownership directories left on disk are discoverable for retry. |

Serialize prepare/commit/cleanup through the production coordinator; active leases prevent startup/foreground cleanup from racing draft promotion or playback. Every delete decision uses current successfully hydrated committed references, not a captured stale list across awaits. Maintain protection until the file operation completes. No eager GC during journal loading/load-error or an active conflicting transaction.

### Restart and cleanup guarantees

After a successful save, a new store + new repository must load the metadata and resolve the durable file offline. Unsaved text/media drafts and in-progress recordings need not survive process termination; say so clearly. Owned unreferenced staging/prepared files may be cleaned after restart; committed document files must not be treated as cache.

Reconcile only after journal hydration succeeds and while no conflicting media transaction runs (startup and explicit retry/foreground are sufficient; no background service). Collect references across ALL journal entries, including missing-file metadata, then inspect only this repository's namespace and valid ownership records; skip active leases. If journal bytes or an ownership record are corrupt, retain files and expose the error rather than guessing. Detect abandoned temporary names inside known owned transaction directories without sweeping unrelated cache. An interrupted delete with files left behind is retried by this scan. Crash after promotion but before JSON commit leaves an owned orphan, not missing committed media; crash after JSON commit retains the referenced file. Test both boundaries.

## Playback and visible errors

Attachment cards show type, duration, size and actual local availability. Audio has play/pause, elapsed/total and restart/seek; video has a native preview/player with accessible controls. Only one clip plays at a time; stop/release before recording, deletion or leaving the surface. Handle loading, failed decode, missing file and retry without mutating journal data. A missing local file or remote-only metadata shows «Файл недоступен на этом устройстве», retains transcript/metadata, and offers a confirmed local attachment removal. Never fetch a guessed URL or claim remote deletion.

Recorder and attachment failures never clear long text, tags, mood or other attachments. Keep Save/Cancel outside scrolling fields and keyboard-safe; retain bounded multiline body scrolling, the full reader and existing history/search ordering. Use current tokens, safe areas, Russian accessibility labels and at least 44pt touch targets. No new design system, gallery, photos, editing timeline or transcript editor.

## Allowed changes and boundaries

Allowed: new media services/components/manifest/tests; minimal Journal model/store/binding/Sheet/row/selectors and Records wiring/guard changes needed for media; mobile package/lockfile/app.json entries listed above; mobile README/status. JournalMedia source comments may describe local ownership but do not add URI/binary/source properties or new transcription enum values. No journal envelope replacement, Ideas changes, new backend/auth configuration or remote writes.

Protect existing Plans, Calendar, notification services, Ideas, Records date helpers, shared theme/components, root navigation and root web/API/DB/worker/Telegram files. Do not weaken/delete the 223 baseline tests (130 Slices 1–3 + 93 Slice 4). Add new test files; narrowly add new cases to an existing file only if necessary. Root build/lint exclusions remain intact.

Explicit exclusions: Finance, Tasks/Goals, server push, Telegram, WebView, cloud upload/sync/auth, remote playback, transcription execution/edit/retry, audio-track extraction, unrelated backend migrations, photo capture/gallery, export/import, background recording/playback, Slice 6 and broad storage redesign.

## Required production-path tests

Use injected fake native/file/clock/permission ports but invoke the SAME controller, repository, coordinator and journal store used by the UI. Tests of unused reducers or reimplemented callback logic are insufficient; inspect native adapter wiring separately. Include meaningful failure injection/deferred promises:

1. Permission granted/denied/non-requestable/restricted/error; no startup prompt; late permission after cancel/replacement; Settings return refresh; initial inactive AppState cannot start capture.
2. One tap start / same control stop for audio and video; duplicate taps; prepare/start rejection; video's long-running record promise does not block stop; undefined result; native auto-stop/deadline/manual-stop races settle once. Flip ready-only; interrupted/background capture stops once, never automatically resumes.
3. Exact 900,000/600,000 ms and 24/80 MiB boundaries; size/duration checked from finalized files; zero/oversize/unknown duration/wrong MIME reject; no truncation or false ready. Timer monotonic under clock changes.
4. Cancel during every await; late native URI cleanup; re-record cleans only the abandoned take; old session A cannot attach to B, mutate B's revision or delete B's file. Busy and changed-draft delayed confirmations refused.
5. Actual repository prepare -> actual JournalStore -> serialized V1 bytes -> brand-new JournalStore/repository -> local playback resolution, for audio, video, multiple attachments and media-only entry. Assert no binary/base64/URI in journal metadata/envelope, while prose/transcripts resembling data URLs survive.
6. Failed file prepare/stat/copy/move/manifest and failed metadata writes preserve previous committed rows/files and retryable text/takes. Retry uses stable take IDs; no duplicate media/entry rows. Parser rejects collisions, wrong parent, malformed media/invalid manifests without rewriting raw data. Every successful mutation reparses through hydration.
7. Delete ordering: zero file deletion before durable metadata/entry removal; failed writes retain old files; cleanup failure after success remains visible/retryable; metadata-only foreign items never delete arbitrary paths. Missing files remain readable as unavailable metadata.
8. Restart/crash between file promotion and JSON commit, after JSON commit, and between metadata removal and file cleanup. GC uses all references, skips active leases, blocks on corrupt/unhydrated journal, retains unknown manifests and cannot race a new commit. Paths remain valid if the absolute sandbox root changes.
9. Long >100k Unicode/multiline body through attach -> save -> restart -> remove attachment -> restart remains exact. Unchanged optional/legacy over-limit fields, tag arrays and existing transcripts survive; frozen wrappers/rows/tags/media remain protected. Dates preserve years 0001/0009/0099/0100, reject 0000, and pass timezone matrices.
10. Text-only Journal and all Ideas behavior unchanged; current sheet lock/identity/revision policy still governs save/delete/reveal; dirty detection includes pending media additions/removals. Playback completion from A cannot control B; playback releases before recording/re-record cleanup.
11. Import/config audit: native media modules are confined to adapters/components, no root/browser/Telegram/backend imports, no auth secrets or media binary in AsyncStorage. Production uses the tested policies, including AppState and native auto-stop callbacks.

## Verification and implementer handoff

Run and report actual results, without changing unrelated files to make them pass:

```bash
# mobile/
npm test
TZ=Europe/Kyiv npm test
TZ=America/Los_Angeles npm test
TZ=UTC npm test
npm run typecheck
npm run lint
npx eslint .
npx expo install --check
npx expo-doctor
npm run export:ios

# repository root
npm run build
git diff --check
```

Full ESLint's three existing warnings in `calendar-notifications.test.mjs` / `calendar-store.test.mjs` are baseline; no new warnings or suppression. Record dependency/doctor/network blockers accurately. Compare protected source/test hashes and inspect package/config/import diff. Do not treat an export as a native build.

Runtime leakage scan (inspect comments separately from imports/calls):

```bash
rg -n 'telegram|TELEGRAM_|localStorage|window\.|document\.|navigator\.|MediaRecorder|next/|cloudflare:|@/lib/|fetch\(|axios|expo-av|react-native-webview' mobile/app mobile/src
rg -n 'expo-audio|expo-camera|expo-video|expo-file-system|base64|data:|arrayBuffer|readAsString|WORKAZY_API_TOKEN|GROQ_API_KEY|oai-authenticated-user-email' mobile/app mobile/src mobile/app.json mobile/package.json
```

New Expo media imports are now expected and must be confined to intended boundaries; do not reuse Slice 4's scan that rejects them wholesale. A data-URL string in a regression fixture or explanatory comment is not a runtime leak. No actual HTTP calls are expected in the local branch.

Update README/status to describe delivered local recording/playback, per-file limits, exact permission/config/build requirements, sandbox file durability, missing-file/cleanup/retry behavior, unsaved-draft/process-death limitations and the deferred authenticated upload/transcription contract. Preserve the >5,000-character backend incompatibility and all prior pending native acceptance. No cloud or real-device claims based on mocks.

Native/device checklist MUST remain pending until actually observed: fresh-install camera/microphone prompts and denial/Settings recovery; physical iPhone front/back capture and portrait orientation; audio input routing; one-tap stop and limit auto-stop; recorded file/container/duration/size; playback/scrubbing; rapid taps and interruption/lock/background; cancel/re-record cleanup; multiple/media-only attachments; offline restart after save; disk-full/write failures; long editor with keyboard/caret at end; compact/notched safe areas and Dynamic Type/VoiceOver; Plans/Calendar/Ideas smoke tests and no unsolicited notification/media prompts. The current machine has only CommandLineTools, not a verified iPhone setup.

**Unit tests and Expo export do not prove camera, microphone, recording, playback, permission prompts or real iPhone behavior.** Report exact observed evidence and separate it from injected-port tests. No fabricated native acceptance, media uploads or screenshots.

Final implementation report: exact files, functioning local flows, storage/ownership/cleanup guarantees, backend deferral reasons, production-path coverage, command outcomes, unchanged Slices 1–4 evidence and pending native checks. Stop after Slice 5; do not start Finance or a credential/backend project.
