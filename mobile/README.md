# Workazy Mobile — iPhone client

Native iPhone client for **Workazy**, a personal planner (планы, календарь, записи,
финансы). This is an independent Expo (SDK 57) + React Native + TypeScript application
using **Expo Router**. No WebView, no Telegram, no browser storage, no web imports.

Slices 1–2 delivered the scaffold, dark theme, four-tab navigation, and the daily
plan (Планы → План) with durable AsyncStorage persistence. **Slice 3** adds the
Calendar tab: Monday-first month grid, selected-day agenda, local CalendarEvent CRUD,
and native local reminders via `expo-notifications`. **Slice 5** adds real native
journal audio/video recording, local playback and offline media durability inside
the Records tab (bounded local branch: no upload, no sync, no transcription yet).

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
| `/(tabs)/records` | **Записи** — Дневник (Новая запись / История) и Идеи (фильтры) |
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

## Records — Journal + Ideas (Slice 4)

- **Дневник**: сегменты «Новая запись» / «История». Панель новой записи показывает
  сегодняшнюю дату (локальную, фиксируется в момент открытия редактора) и реальную
  кнопку «Написать запись»; модалка не открывается автоматически при входе.
  История — FlatList с датой, необязательным заголовком, превью текста и
  метаданными (настроение/теги/вложения), сортировка по дате и `createdAt`
  (отсутствующий — после присутствующего), стабильная для совпадений.
- **Редактор дневника** (full-screen native modal): необязательный заголовок,
  большое ограниченное по высоте поле текста со скроллом (курсор/выделение
  доступны даже для очень длинного текста), настроение (Спокойно, Энергично,
  Тяжёло, Радостно — повторный тап снимает), теги через запятую. Внешний trim
  совпадает с веб-сохранением; все внутренние переводы строк, пустые строки,
  эмодзи и пробелы сохраняются. **Локальный текст не имеет лимита приложения**
  (лимиты 300/60/20×40 — это правила ввода с видимыми ошибками; `maxLength` в
  TextInput не обрезает текст).
- **Правки полей изолированы**: валидация и нормализация применяются ТОЛЬКО к тем
  полям, которые пользователь реально изменил. Правка тегов не трогает тело
  (пробелы остаются байт-в-байт), правка тела не удаляет существующие пустые
  заголовок/настроение, а легаси-значения сверх текущих лимитов (длинный
  заголовок, длинное описание идеи) не мешают править другие поля. Правка самого
  поля по-прежнему упирается в лимит.
- **Контракт даты 0001–9999 применяется во ВСЕХ Records-хелперах**, а не только
  при создании: `isSupportedRecordsDate` (валидация), `localIsoDate`/`todayIso`
  (вывод даты, `string | null`) и `formatJournalDate`/`formatJournalFullDate`
  (отображение, `null` вместо даты) возвращают null/отказ для года 0000 и
  невозможных дат, поэтому ни один путь не выводит и не сохраняет «0000-01-01».
  Ранние годы 0001/0009/0099/0100 и современные годы работают как прежде, без
  remap 0–99 в 1900-е. Если часы устройства вне диапазона, панель новой записи
  показывает честное сообщение вместо выдуманной даты.
- **Контракт записи**: при создании дата проверяется по тому же диапазону,
  коллизия сгенерированного ID отклоняется, и ни один успешный мутатор не пишет
  байты, которые парсер не смог бы загрузить (перед записью байты проверяются тем
  же парсером).
- **Чтение**: полноэкранный ридер резолвит запись из committed-состояния по ID,
  показывает настоящий текст (выделяемый, прокручиваемый), настроение, теги и
  честную заметку о метаданных вложений (без поддельных плееров).
- **Идеи**: категории Мысль / Хочуха / Проект / Покупка / Когда-нибудь и статусы
  Новая / Думаю / В план / Сделано / Архив; по умолчанию Мысль/Новая; новый
  элемент добавляется в начало, правка и смена статуса сохраняют позицию;
  фильтры категории/статуса — только UI, с «Все» и логикой AND, повторный тап
  возвращает «Все». Быстрая смена статуса доступна в ридере (как inline-select в
  вебе) и не закрывает карточку. «В план» не создаёт PlanTask/Goal.
- **Безопасность асинхронности**: одна синхронная блокировка на редактор покрывает
  сохранение, смену статуса и удаление до первого `await` (finally-освобождение);
  пока операция идёт, поля/кнопки/жесты закрытия отключены. Грязная отмена/back
  подтверждается; завершение старой операции сверяется с ТЕКУЩИМ `sheetKey`, поэтому
  не может закрыть/перевести/очистить более новый редактор (идентичность текущего
  листа обновляется синхронно вместе с состоянием, без пассивного эффекта), а
  отложенные подтверждения удаления/отмены перепроверяют актуальные идентичность,
  ревизию черновика и busy-состояние перед закрытием или записью. Успешное создание
  закрывает редактор и открывает Историю; успешная правка НЕ закрывает лист, а
  возвращает к карточке чтения сохранённой записи и очищает поиск только если он
  её скрывает; удаление закрывает только свою карточку.
- **Локальные поиск и состояния**: нечёткий регистронезависимый поиск по
  заголовку/тексту/настроению/тегам/транскриптам; отдельные loading, load-error с
  Retry, ready-empty, filtered-empty и write-error состояния для дневника и идей
  (повреждённый дневник не блокирует идеи и навигацию). Сегменты, режим/поиск и
  фильтры живут выше условного рендера и переживают переключения.
- **Опубликованные снимки неизменяемы полностью**: заморожены и сам объект
  состояния (`phase`/`entries`/`ideas`/`saving`/`error` — их нельзя заменить или
  изменить), и содержимое (committed-строки, массивы тегов, массивы вложений,
  объекты метаданных и общие пустые константы). Поэтому внешняя мутация любого
  снимка из `getSnapshot()` не меняет состояние стора, не уведомляет подписчиков,
  не пишет в хранилище и не попадает в последующую легитимную запись.
- **Хранение**: два независимых конверта AsyncStorage — `workazy-native-journal-v1`
  `{ version: 1, entries, savedAt }` и `workazy-native-ideas-v1`
  `{ version: 1, ideas, savedAt }`. Строгий структурный парсер: повреждённые
  JSON/версия/строки/даты/таймстемпы/дубликаты ID/метаданные вложений → load-error
  без перезаписи байтов; ретрай перечитывает только свой ключ. Запись — только через
  полную персистенцию (persist-before-commit) с синхронным write-gate в сторе, без
  сидов, глобального clear и доступа к ключам Plan/Calendar.
- **Вложения — только метаданные (задел под Slice 5)**: полная схема
  `JournalMedia` (audio/video, mimeType, sizeBytes, длительность/размеры, транскрипт,
  статус транскрипции, таймстемпы) валидируется и сохраняется как есть, переживает
  правки текста и неудачное удаление; строки только с метаданными читаются.
  Свойства, несущие байты (Blob/File/ArrayBuffer/типизированные массивы/base64/
  data-URL/URI временного воспроизведения), отклоняются явной схемой, а проза и
  транскрипты, лишь похожие на data-URL, остаются валидными. Записи/загрузка/
  воспроизведение/транскрибация не реализованы, кнопок медиа нет.

## Journal media — native recording and playback (Slice 5)

Slice 5 adds **real native audio/video recording, preview, re-recording, multiple
attachments and offline playback inside Journal**. This is the bounded
**local-media** branch: no cloud upload, no sync, no remote playback and no
transcription execution yet. Nothing about media is faked — there are no inert
upload buttons, no fake percentages and no cloud badge.

### What works offline

- **Аудио**: one tap starts (permission → prepare → record), the same control
  stops; live timer; preview with play/pause/seek/restart; «Использовать аудио»,
  «Записать заново», cancel. AAC/M4A (`audio/mp4`), 96 kbit/s mono for voice.
- **Видео**: full-screen camera surface inside the sheet (front camera first),
  one tap records, the same control stops, timer, camera flip (idle only —
  flipping stops a take, so it is offered only when idle), Close. 720p target at
  900 kbit/s, H.264 (`avc1`), MP4/MOV.
- **Attachments**: several per entry; a **media-only** entry is valid (at least
  one real file). Reader shows metadata, real availability («На устройстве»),
  audio progress and native video controls; only one clip plays at a time.
- **Durability**: a prepared file is copied into app-owned storage with a strict
  ownership manifest **before** any journal metadata may reference it. Journal
  snapshots still contain metadata only — no binary, no base64, no file or
  temporary URI.

### Per-file limits (per file, not decimal MB, not per entry)

| Kind | Duration | Size |
| --- | --- | --- |
| Audio | 900,000 ms (15 min) | 25,165,824 bytes (24 MiB) |
| Video | 600,000 ms (10 min) | 83,886,080 bytes (80 MiB) |

Limits mirror repository `lib/media-limits.ts`. The native limits are guards, not
proof: the finalized file is stat-ed and its duration is read from native status
(and loaded media for video). Zero bytes, unknown/non-finite duration, an
unsupported container or an over-limit file is an error with re-record/cancel —
never a truncated, renamed or silently saved file.

### Permissions (requested only after you tap Аудио/Видео)

- Nothing is requested at startup. Camera and microphone are requested only when
the user explicitly starts a recording action (or explicitly retries).
- Audio needs the microphone; video needs camera first, then microphone,
  sequentially. A denied microphone never starts a silent video.
- Denied/restricted states show a Russian explanation, «Повторить» while the
  system still allows asking, and «Открыть настройки» (`Linking.openSettings`).
  Returning from Settings refreshes the permission state **without** prompting or
  recording automatically.

Config (both strings must match):

```json
["expo-audio", { "microphonePermission": "Workazy использует микрофон для аудио- и видеозаписей дневника.", "recordAudioAndroid": true, "enableBackgroundPlayback": false, "enableBackgroundRecording": false }],
["expo-camera", { "cameraPermission": "Workazy использует камеру для видеозаписей дневника.", "microphonePermission": "Workazy использует микрофон для аудио- и видеозаписей дневника.", "recordAudioAndroid": true, "barcodeScannerEnabled": false }],
["expo-video", { "supportsBackgroundPlayback": false, "supportsPictureInPicture": false }]
```

`expo-file-system` needs no plugin for private sandbox files (iOS file sharing
stays disabled). `expo-asset` is a required direct dependency of `expo-audio`
(`npx expo-doctor` fails without it). **Config-plugin changes require a new native
binary**: an existing installed build will not show these strings.

### Where files live

- Staging (temporary, app cache): `Paths.cache/workazy-journal-media/v1/staging/<session>/`
- Durable (survives, backed up with the app):
  `Paths.document/workazy-journal-media/v1/objects/<local-media-id>/recording.<ext>`
  plus `manifest.json` `{ version, mediaId, fileName, mimeType, sizeBytes, durationMs, createdAt }`.
- Absolute container paths are **never** stored: locations are derived from the
  current sandbox root, so files keep working if the container path changes.
- A valid manifest plus a contained generated path establishes ownership. Unknown
  or unowned metadata never authorizes deleting a file, and a prefix alone never
  marks a file as orphaned.

### Media ownership phases (who may delete a file, and when)

Every file passes through exactly these phases. Only the phase owner may delete it,
and each transition is explicit in code:

| Phase | Owner | Protection | Cancel / unmount | Save failure | Abandonment | After a successful commit |
| --- | --- | --- | --- | --- | --- | --- |
| Native temp file (recorder output) | OS/recorder | that session's native handle | deleted by ITS session teardown, at most once (a stale session never touches a newer one's temp file or hardware) | deleted | deleted | deleted after adoption |
| Recorder-owned take (preview) | recorder session | recorder session | deleted | n/a | n/a | n/a |
| Adopted/staged take | **transferred to the editor draft** after a successful «Использовать» | draft media lease | **never deleted by the recorder** — teardown no longer sees it | kept + leased for retry | deleted by the draft abandonment path | — |
| Transferred editor/draft-owned take | editor/draft (sheet + coordinator) | draft media lease until commit | the editor's own abandonment removes it | kept + leased | deleted (staged file and an unreferenced promoted object) | — |
| Committed Journal attachment | Journal metadata | committed reference (freshly re-read before any delete) | playback stops, file stays | file stays; the retry verifies it | removed only by a confirmed local removal, metadata first | the file is protected by its reference forever |

Two guarantees follow from the table: the recorder keeps **no reference** to a take
after a successful Use (its cancel/unmount cannot delete editor-owned media), and a
sweep can never delete a file that any later phase owns.

### Race safety, retry and deletion guarantees

Media files are only ever deleted by code that re-reads the authoritative state
immediately before the delete. When the state is uncertain, the app keeps the file
(a temporary leak) instead of risking user data.

- **Sweeps cannot delete freshly committed media.** Destructive sweeps and
  attachment commits/adoptions/deletes are serialized through one coordinator
  operation lock. Inside a sweep, every ASYNC ownership lookup (directory listing,
  manifest read) happens first, and then ALL authoritative guards — committed
  references, session leases, draft/media leases, the `canDelete` uncertainty gate
  and the ownership/path validity check — are re-read synchronously with **no await
  between them and the destructive delete** (the delete call itself is the only
  awaited operation). A sweep that started before a save can never remove the file
  that save published; a reference or lease added while an ownership read was
  still in flight is seen and the file is kept.
- **Leases follow the whole draft lifecycle.** A recorder session protects its
  staging directory from the moment its surface opens; an adopted take is leased
  while it waits unsaved; a successful save moves protection to the committed
  Journal reference; discarding/abandoning a draft releases the lease and removes
  only that take's own files; a failed save keeps the lease and the file so the
  same take ids can be retried. No permanent leaked lease remains after a success,
  a discard or a retry, and cleanup failures stay visible and retryable.
- **Retry verifies the recording itself.** Before a retried save can commit
  metadata, the durable file is re-checked (ownership manifest **and** the actual
  recording: present, not a directory, non-zero and exactly the recorded size).
  If the file vanished or was truncated, the retry fails with «Файл недоступен на
  этом устройстве», the committed Journal stays unchanged and no missing-file
  attachment is written. A complete file retries idempotently (same take id, no
  duplicate rows).
- **Delete order is fixed everywhere**: attachment removal and entry deletion
  persist the metadata removal first and only then remove owned files; a failed
  write deletes nothing. Cleanup that fails *after* a successful removal is
  reported and retried by the next sweep.
- **Every destructive path** (sweep, cancel, re-record, attachment delete, entry
  delete, stale-recorder cleanup, draft abandonment) removes only app-owned files
  that a valid ownership record proves this app created, and never removes a file
  that is committed, leased, needed for a retry, or in an uncertain state.

### Recorder identity, cancellation and permissions

- A recorder surface records the sheet identity, draft revision and its own
  session/generation when it opens. Attaching a take is authorized by one shared
  policy that reads only SYNCHRONOUS authoritative sources: the PARENT's current
  sheet identity (its own ref, never a rendered prop), the parent's lock/busy
  state, the live draft identity/revision, the recorder session/generation and
  whether the surface is still mounted. The check runs **before** adoption (so a
  superseded recorder does not even promote a file) and **again** after the awaited
  adoption, before any transfer. A stale recorder can therefore never attach media
  to a newer draft, never replace the newer draft's owner, and its orphaned take is
  cleaned instead.
- **Hardware ownership is process-global, not per surface.** All recorder binding
  instances share ONE process-level hardware coordinator
  (`recorderHardwareCoordinator`), because the native recorder and the audio-session
  mode are process-global. Its invariants: one authoritative owner at a time,
  identified by `{ sessionId, epoch, kind }` with the epoch minted per activation; a
  binding instance is never an ownership boundary; every hardware operation (mode
  change, prepare, start, stop, release) is queued on ONE chain and re-checks
  ownership when it runs; the ownership handoff itself is queued behind in-flight
  hardware work, so a new session cannot take over while an older hardware-affecting
  operation is still settling; the status-listener slot has one owner and only its
  owner may clear it. Consequently a delayed stop/release/mode-restore from surface A
  can neither disable nor interrupt surface B, and an in-flight stale completion can
  never overwrite the shared ownership of B. Correctness is preferred over instant
  handoff.
- **A native handle is single-use.** Session lifetime is explicit: new session →
  native handle created → preparing → recording → stopping → finalized → handle
  released and forgotten → preview. Once finalized the handle is unusable forever and
  the controller keeps no reference to it, so «Записать заново» (re-record) mints a
  NEW session id, generation and handle before returning to the camera-ready state;
  the same holds for audio, where the next take always opens a fresh session.
- **Backgrounding during preparation cannot start a capture.** The lifecycle
  authorization (the real app state in production) is re-checked immediately before
  the native capture call: a preparation that finishes while the app is inactive or
  backgrounded never calls native start, releases only its own prepared resources
  and returns to an idle surface with no recording and no error card.
- **Native resources are session-scoped.** Every recorder session owns its own native
  handle: its result promise, stop, release, auto-stop registration, duration
  sampling and status listener belong to that session id, and only that session may
  clean them. Shared hardware slots are guarded twice: the status listener is owned
  by exactly one session at a time (a stale release can only clear the listener IT
  installed), and shared device-mode changes run through a queue that re-checks
  ownership at call time, so a release resuming after a newer session started is
  skipped (or, if it already landed, the newer session's recording mode is
  re-asserted). A cancelled session therefore never releases, stops or blinds the
  recorder of a newer session of the same kind, even with the same surface and
  editor.
- **Session leases never accumulate.** The recorder session is leased
  SYNCHRONOUSLY at the instant its id is created (before any native await), and a
  new session releases the previous one first; re-record, permission retry,
  recorder restart and kind switch therefore keep exactly one live session lease,
  an unmounted surface releases whichever session is current, and no stale
  asynchronous startup completion can re-register an obsolete session (there is no
  asynchronous registration path at all).
- Cancelling permanently invalidates the session: the operation generation is
  bumped, and every awaited native result is re-checked before any state is
  published — including after `releaseNative()` resolves — so a late finalization
  can never return the surface to preview or attach media. A late native URI arriving after cancellation is discarded exactly
  once (including when the cancel happened while starting). Re-record invalidates
  the previous take the same way, and re-record is refused while a finalization is
  still in flight. Closing the surface cancels and invalidates the controller,
  cleans owned uncommitted files and detaches the lifecycle listener.
- Video is only ready when **both** camera and microphone are usable. Returning
  from Settings re-reads both, and a permission that became unusable while the
  surface was already ready moves it OUT of ready immediately: `startVideoRecording`
  then rejects without any native capture call (verified for both a revoked camera
  and a revoked microphone). A granted camera with a denied microphone never starts
  a silent video. Permission results are scoped to the
  session generation, so a late answer from a previous session of the same kind is
  ignored.
- The duration used for validation is the **authoritative duration of the finalized
  file**, obtained after the recorder stops by loading the file with the SDK's audio
  player (`createAudioPlayer` → decoded media duration). While-recording sampling
  (status events + the same polling cadence the SDK's `useAudioRecorderState` uses)
  remains only a UI/fallback value: a manual stop, an AUTOMATIC `forDuration` stop
  and the iOS post-stop reset to zero all validate against the finalized file, so a
  take cannot be accepted with a stale lower sample (e.g. saving 4 750 ms for a
  5 000 ms recording, or passing a 900 001 ms recording under the limit). Every
  take starts from an empty duration state (no value leaks from a previous take),
  and when the finalized duration cannot be obtained the take fails with a clear
  «Не удалось определить длительность записи» instead of being accepted.
- **Sibling takes are isolated on disk.** Discarding a take removes only that
  take's own staged file; an owned directory is never recursively deleted based on
  an emptiness observation that could go stale across an await. Only the sweep
  removes a session directory, only for sessions with no live lease, with its
  ownership/reference/lease guards re-read synchronously immediately before the
  delete. An empty owned directory may therefore remain until then — harmless
  leakage is preferred over deleting sibling data.
- **Active playback ownership is identity-guarded.** The sheet clears/replaces the
  active media id only through helpers that compare the CURRENT id with the card's id
  (`clearActivePlayback` / `claimActivePlayback`), so a late `onFinished` or failure
  callback from media A can never clear or replace media B — including after a failed
  pause in A's cleanup.
- **A playback controller lives as long as its native player, never as long as a
  callback.** Each card builds one stable player lifecycle
  (`playerLifecycle.ts`): parent callbacks are re-bound on every render WITHOUT
  touching the controller or the player, and the controller/player is retired
  exactly once only when the native player/source instance really changes (a retry
  remount) or the card unmounts. An ordinary parent rerender — including a changed
  `activeMediaId` and therefore changed inline callbacks — can no longer dispose
  playback or hand a removed player to a new controller. Audio and video both use
  this exact implementation.
- **A failed physical stop blocks the handoff (never two recorders).** Each capture
  registers a physical-stop DUTY with the process-global coordinator when it starts,
  with an explicit state (`required` → `stopping` → `confirmedStopped` / `failed`).
  The handoff runs that duty before transferring ownership, and the duty is cleared
  ONLY on confirmed capture end — a rejected stop keeps the state `failed`, keeps the
  duty, and refuses the handoff with a typed recoverable failure
  («Предыдущая запись ещё завершается. Повторите через пару секунд.»). Stale cleanup
  cannot erase a pending/failed duty. Retrying the action re-attempts the stop, and
  only after it is confirmed does the next capture start: one stuck recorder is
  preferred over two concurrent captures.
- **A physical reservation is independent from the logical owner.** The coordinator
  tracks a logical owner AND a physical reservation per capture. A logical
  release/cancel/unmount clears only the owner: the reservation survives while that
  capture is not confirmed stopped, so `owner === null` never means the hardware is
  free. EVERY activation first resolves (or retries) all outstanding reservations
  regardless of who — if anyone — is currently the logical owner, and refuses with
  the typed recoverable `hardware-busy` failure when one cannot be confirmed. Only a
  confirmed stop clears a reservation, and stale cleanup of another session can
  never erase it.
- **Activation failures are handled eagerly.** Session construction settles the
  hardware activation into a typed outcome (`{ ok } | { ok: false, error }`) the
  moment it is created, so a `handoff-blocked` refusal can never surface as a
  process-level unhandled rejection — including when the permission prompt is still
  pending, when the user denies permission and `start()` is never called, or when
  the sheet unmounts before the outcome settles. The stored outcome is consumed on
  the next start/stop lifecycle step and reported honestly (`hardware-busy`), never
  swallowed.
- **Video handoff waits for capture COMPLETION, not the stop command.** For video the
  physical duty requests `stopRecording()` and then awaits the ORIGINAL `record()`
  completion promise for that exact session — the only proof the camera actually
  stopped. A gated/delayed completion, a rejecting completion or a rejecting stop
  request all keep the duty pending (blocked handoff, no second capture); the take
  path never infers completion from the stop command alone.
- **Only one physical recorder may be capturing.** Every capture registers its
  PHYSICAL stop with the process-global coordinator the moment it starts, and the
  coordinator's ownership handoff runs that stop before the new owner becomes
  authoritative. A stale logical owner can therefore never leave a live recorder
  behind, a stop that arrives late (or after supersession) still physically stops
  the capture, and a new session's start waits until the previous capture has
  actually stopped.
- **Lifecycle is re-checked inside the queued start, not only before queueing.** The
  final gates (ownership, session/disposed, app-active authorization) run inside the
  shared-coordinator callback immediately before the native capture call, so an app
  that backgrounds while a start waits in the hardware queue starts nothing at all
  (audio and video).
- **Every process-global audio-mode mutation runs on the shared hardware queue.** The
  recording-mode enable and the release-time playback-mode restore both go through
  the SAME coordinator queue as activation, prepare, native start/stop and release —
  there is no fire-and-forget global mode change anywhere. The release-time restore
  cannot require logical ownership (the owner is released right after), so it is
  re-validated WHEN IT RUNS: a newer logical owner, another session's unresolved
  physical reservation, or its own still-unresolved capture makes it `skipped`. Since
  every native start is queued behind it, a delayed stale restore can never land
  underneath a newer recording owner (worst case the new capture simply waits for the
  in-flight transition to settle first).
- **Video participates in the same guarded active-playback ownership as audio.** The
  video player drives every real expo-video event (`playingChange`, `statusChange`,
  `playToEnd`) through the production event bridge into the shared playback
  controller. A NATIVE-controlled start (the video's own play button, which never
  calls `toggle()`) therefore acquires the controller's exclusivity and claims the
  sheet's active id through the same callbacks audio uses; a native pause keeps that
  ownership (the clip stays the active media until it ends, fails, or another clip
  takes over), and completion/error release it through the same centralized cleanup —
  so the active id can never be left stale by a natively started video. The bridge is
  the exact production module the player wires, not a test look-alike; the sheet clears the active id only through the identity-guarded
  helper (`clearActivePlayback(current, mediaId)`), so a finished, failed, replaced
  or unmounted video clears its OWN id and a stale callback from an earlier video can
  never clear a newer clip. Audio and video share that one sheet-level id — there is
  no per-card active truth.
- **Playback failures are cleaned up, not just reported.** One lifecycle controller
  (used by both players) drives every command: a native status error, a rejected
  play/pause/seek, a failing completion rewind or a load error runs the same safe
  cleanup exactly once — mark failing → guarded pause → guarded release → clear
  exclusive playback ownership → honest unavailable state — so no native playback
  continues behind an error card and no rejection escapes unhandled. Switching
  attachments and unmounting guard pause/release too — and a FAILED stop while
  switching attachments is treated as a real playback failure (the player is
  released, exclusivity is yielded and the card reports it honestly) rather than
  being swallowed behind the new clip; completion rewinds and stays replayable, or
  reports the rewind failure. Retry starts from a clean released
  state, re-resolves the committed media and mounts a fresh native player; a failing
  retry stays honest, and the attachment metadata is untouched.
- **Playback failures are honest.** A native load/playback error, a rejected
  play/pause/seek command or a missing/undecodable file shows «Не удалось
  воспроизвести запись» / «Файл недоступен на этом устройстве» with a Retry that
  re-resolves the committed local media; the card never claims a file is playable
  after a failure, and the attachment metadata stays intact unless the user
  explicitly deletes it. Retry that fails again stays honest (no fake success).
- **Existing transcripts are displayed (read-only).** An attachment with a stored
  transcript shows the full text in a bounded, collapsible section (long text can
  be expanded; the stored data is never truncated); an attachment without one shows
  no section, and existing status metadata is described honestly («Расшифровка
  пока недоступна», «Расшифровка не удалась»). No transcription execution, upload
  or editing exists, and no cloud behaviour is implied. The value is never clamped: a take longer than the limit is rejected
  with re-record instead of being silently truncated or saved. The policy is
  documented and intentional: duration must be > 0 and ≤ 900,000 ms (audio) /
  600,000 ms (video) — exactly at the limit is accepted, one millisecond above is
  not.
- Audio attachment cards reflect the REAL playback state: the same control plays,
  then pauses, then resumes from the current position; completion pauses, rewinds
  and releases exclusivity so the next tap replays. A missing/undecodable file
  still shows the honest unavailable state with retry.

### Missing files, cleanup and retry

- A missing/corrupt file shows «Файл недоступен на этом устройстве» with retry and
  a **confirmed local removal**; the transcript/metadata stay intact and nothing is
  deleted automatically. No URL is ever guessed and remote deletion is never claimed.
- Deleting an attachment or an entry persists the metadata removal **first** and
  deletes owned files only afterwards (an interrupted delete is retried by the next
  sweep). A failed metadata write deletes nothing.
- Cancel/re-record and draft abandonment remove only the abandoned take's own
  staged/promoted files (one take's cleanup never touches a sibling take of the
  same recording session); a late native URI arriving after cancel is discarded
  exactly once instead of being attached.
- On startup, after the journal loads successfully, one sweep removes owned,
  unreferenced, unleased files (abandoned staging and orphans). It never runs
  while the journal is corrupt/unhydrated or mid-write, skips session and draft
  leases, keeps unknown/corrupt ownership records, and re-reads the authoritative
  references before each individual delete. Cleanup failures after a successful
  removal stay visible and retryable — they never report the save as failed.

## Code structure

```text
app/                      # Expo Router routes (root layout mounts calendar lifecycle)
src/theme/                # design tokens: colors, spacing, radius, typography, shadows
src/components/           # Screen, AppText, Card, SegmentedControl, SectionIntro
src/types/plan.ts, calendar.ts, journal.ts, idea.ts   # mirrored web domain types
src/storage/planStorage.ts, calendarStorage.ts, journalStorage.ts, ideaStorage.ts
                          # key/envelope/parser (injected storage)
src/features/plans/       # daily plan (pure model/dates/store + binding + UI)
src/features/calendar/    # calendar (pure model/dates/store + binding + lifecycle + UI)
src/features/journal/     # journal (pure model/selectors/store + binding + rows + sheet)
src/features/ideas/       # ideas (pure model/store + binding + row + sheet)
src/features/records/     # Records owner: workspace screen, date helpers, sheet policy
src/features/journal/media/            # recorder overlay, attachment cards, players
src/services/media/       # recorder controller, local media repository, coordinator,
                          # playback/recorder/file bindings (the only Expo media imports)
src/storage/localMediaManifest.ts      # strict V1 filesystem ownership manifest
src/services/notifications/            # pure contract/planner/reconciler + Expo binding
assets/images/            # only launch/icon assets referenced by app.json
```

Pure domain logic lives in the plan/calendar/journal/ideas `*Model.ts`,
`*Dates.ts`/`*Selectors.ts`, `*Storage.ts` and `*Store.ts` modules — the ONLY
modules importing AsyncStorage, Expo Crypto, or expo-notifications are
`usePlanStore.ts`, `useCalendarStore.ts`, `useJournalStore.ts`, `useIdeaStore.ts`
and `expoCalendarNotifications.ts`. Tests import the pure chain directly with
injected storage/clock/IDs/fake OS.

Slice 5 keeps the same split: `mediaLimits.ts`, `mediaContracts.ts`,
`recorderController.ts`, `localMediaRepository.ts`, `journalMediaCoordinator.ts`
and `localMediaManifest.ts` are pure (injected permission/native/file/clock ports),
while Expo modules appear only in `expoMediaFiles.ts`, `expoRecorderBindings.ts`,
`useJournalRecorder.ts`, `journalMediaRuntime.ts` and the two media components.
The recorder/permission file/clock ports are faked in tests, so the SAME
controller, repository, coordinator and journal store used by the UI are covered.

## Data and backend isolation

- **Data is local to this installation**; the app makes no requests to the product
  server, stores no credentials, and has no cloud/sync claims.
- **No Telegram**, no server reminder tick, no system-calendar integration, no
  recurrence, no push/APNs credentials. Calendar reminders use `expo-notifications`
  local scheduling only; OS delivery remains subject to user/system settings.
- **Journal/Ideas are local-only**: text, optional title, mood and tags are stored
  on this device (`workazy-native-journal-v1` / `workazy-native-ideas-v1`). No
  cloud sync, no auth and no conflict resolution exist; the app never fabricates a
  connected-cloud state.
- Tasks/Goals CRUD, Finance and later slices remain unimplemented.

## Visual references

Visual source of truth is the screenshot set in the repository at `references/`
(copied from the harness bundle `/Users/oleh/Downloads/workazy-mobile-harness/references/`).
The harness bundle must be available on this machine for a visual pass.

## Current limitations (Slices 1–5)

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
- Unsaved editor drafts (Journal/Ideas included) are not process-durable;
  termination during a pending save is not claimed durable, and there is no
  autosave infrastructure (successful saves restore exactly).
- **Journal local size vs. backend**: local bodies have no application cap and
  long entries are preserved (tested at 100,000+ characters), but entries above
  the web API's 5,000-character body limit are **not currently backend-write
  compatible**. Any future sync must resolve this explicitly without truncating
  local text.
- **Media deletion safety beats space**: an uncertain ownership/reference state (a
  corrupt journal, a mid-write store, a throwing reference read) always leaves the
  file on disk; a temporary file may stay until the next sweep rather than risk
  deleting something committed, leased or still needed for a retry.
- **Media upload and transcription are deferred**: Slice 5 records, stores and
  plays media locally only. There is no upload, sync, remote playback or
  transcription execution, because the authenticated backend contract is not
  safely reusable from mobile yet (no API base URL/credential acquisition/trusted
  owner identity; the server Journal body cap of 5,000 characters is unresolved;
  no bounded native audio-track extraction for video). Existing transcripts are
  displayed read-only and never re-interpreted. Deleting media is local only — the
  app never claims to delete R2 objects.
- **Media files are app-private**: recordings live in the app sandbox (not the
  Photos library), are removed if the app is deleted, and are not transferable
  between installations. Unsaved drafts and in-progress recordings do **not**
  survive process termination (only committed entries and their files do).
- **Background recording/playback is disabled**: capture stops once when the app
  leaves the active state and never auto-resumes; playback and PiP in the
  background are off.
- Records have no reminders, no export/import and no server sync; Ideas `plan`
  status does not create a Plan task/goal.
- iPhone simulator/device launch, the OS notification permission prompt, actual
  banner/sound delivery, datetimepicker interactions, long-editor keyboard/
  scroll/caret behavior, Dynamic Type/VoiceOver with a large journal entry, and
  on-device restart convergence are **not yet verified** on the implementation
  machine (only Xcode CommandLineTools installed; no simulator). The Slice 5
  camera/microphone prompts, physical capture, playback, file/container checks and
  limit auto-stop are likewise **pending** real-device verification. Unit tests
  and an Expo export do not prove camera, microphone or playback behavior. Do not
  treat Slices 1–5 as passed until native evidence exists. See `MIGRATION_STATUS.md`
  for exact status.
