# Slice 6B — Finance local notification architecture brief

Prepared 2026-09-13. **Architecture only. Slice 6B is not implemented by this task.** The starting worktree was clean and HEAD was verified as `5a5486b4106b52e5372ba52e810d88ca01d2c629`. The user identifies this checkpoint as Slice 6A REVIEW_OK. Its recorded baseline is 472 passing tests; that suite was not rerun for this documentation task. iPhone/native acceptance remains pending. This revision addresses the architecture review only; the brief was already modified when this revision task began. Implementation is split into 6B.1 and 6B.2, with independent Codex REVIEW_OK required between them.

This document replaces the earlier Slice 6 brief. The protected Finance core contract and its implementation remain available at the checkpoint, including `git show 5a5486b4106b52e5372ba52e810d88ca01d2c629:tasks/current-task.md`. No Finance money, allowance, migration or persistence contract is superseded here. MASTER_PROMPT.md and tasks/mobile-migration.md already support local reminders and isolated reconciliation under shared capacity; no amendment is needed.

## 1. Current implementation audit

The architecture is based on the current source, the seven requested source-of-truth documents, and the Calendar and Finance tests, rather than the older illustrative architecture examples.

| Current component | Actual behavior and boundary to preserve |
| --- | --- |
| `services/notifications/expoCalendarNotifications.ts` | The Expo-facing notification boundary. Maps permissions, lists/decodes pending requests, schedules deterministic DATE requests, cancels individual IDs and installs the foreground handler. Writes Calendar ownership, fingerprint, `targetTriggerAt` and JS `scheduledAt` into data. No response/tap handler. |
| `calendarNotificationContract.ts` | Calendar request type, namespace/owner and ID helpers; pending request and permission types; trigger decoding/classification. Existing Calendar ownership recognizes its ID prefix OR owner metadata. Do not silently tighten or rename this existing contract during extraction. |
| `calendarNotificationPlanner.ts` | Timed event always produces a future `start`; recognized optional advance produces an additional alert. Untimed/past triggers produce none. Sorts by instant, event ID, kind. Body contains event title/time, never note. DST conversion uses `zonedDateTimeToUtcEarlier`. |
| `calendarNotificationReconciler.ts` | Reads permission without prompting; lists inventory, preserves foreign requests, clears obsolete/changed/out-of-window owned requests, re-lists before allocating capacity, schedules with durable registry bookkeeping and fresh-clock/revision checks, verifies native content/trigger, and recovers owned orphans. Intended total cap is 48. A successful schedule consumes capacity even if readback fails, but an ambiguous schedule rejection currently leaves capacity accounting stale; the narrow safety correction below is required. |
| Calendar verification | Matcher checks ownership fields, fingerprint, actual title/body and decodable trigger. Callers locate the deterministic ID. A present persisted target adds an exact constraint; metadata is not native proof. Absolute trigger tolerance is 2,000 ms; iOS interval uses the existing 30,000 ms handoff budget and `scheduledAt` decoding context. Unknown shapes fail. These are current adapter policies, not observed device guarantees. |
| Calendar registry | `CalendarNotificationRecord` contains ID, eventId, start/advance kind, fingerprint, scheduled/tombstone status and timestamps. It lives WITH events in `workazy-native-calendar-v1`, version 1. Current code prewrites a record labelled `scheduled` before the OS call: that label alone cannot establish native success. Preserve current schema and cancellation/tombstone protocol; do not migrate it to the new Finance registry. |
| `calendarStore.ts` / `calendarStorage.ts` | Hydration gate, strict whole-snapshot validation, persist before publication, synchronous write lock. `setRegistry` merges into current committed events. Event revision changes on hydration/CRUD, not registry writes. Registry persistence can return busy/error. |
| `calendarReconcileCoordinator.ts` | Captures event revision, supplies `shouldAbort`, and reruns against current state, bounded to 16 passes. There is no process-wide Calendar/Finance exclusion. |
| `calendarNotificationController.ts` | Per-Calendar coalesced reconcile flight, today marker, active-only ticks, focus/foreground and permission refresh. Delayed permission results merge into latest controller state. Explicit permission request currently has no cross-domain single-flight guard. |
| `useCalendarLifecycle.ts` / `CalendarScreen.tsx` | Root mounts lifecycle once: foreground handler, Calendar hydration, one notification AppState listener and 60-second active refresh. Screen focus retries; committed CRUD awaits Calendar reconciliation. Permission banners, Settings, quiet/provisional, capacity, retry and DST warnings already exist. Preserve these behaviors and sheet guards. |
| Root `mobile/app/_layout.tsx` | Mounts Calendar lifecycle, theme and Stack. Current source has no notification-response listener or cold-start tap dispatcher. Do not claim an existing Calendar event-opening tap flow. |
| Finance types/model/store/storage | Four obligation kinds; optional dueDate/time, explicit `reminderEnabled`, completed/completedAt. `workazy-native-finance-v1` is the existing flattened V1 envelope with monotonic committed revision. Parser, aggregate checks, deep freezing, write gate and allowance-first commands are protected. No Finance OS registry or scheduling exists. |
| Finance UI/binding | `useFinanceStore.ts` creates the store singleton; FinanceScreen hydrates on mount and uses sheet identity/opening-revision guards. Obligation form defaults reminder OFF, suggests 09:00, validates date/time, and displays deferred Slice 6B copy. Obligations list currently displays intent, not native scheduling status. |
| Existing tests | Calendar notifications/controller/coordinator/store/model/date/sheet tests cover native matching, capacity, stale passes, persistence, DST and lifecycle. Finance money/model/store/legacy/fixes/fixes2/wiring tests protect the 6A core. Some wiring assertions deliberately describe the temporary absence of 6B; see §13 for their bounded replacement. |

**Confirmed safety defect to correct in 6B.1:** with 47 foreign pending requests, the current Calendar reconciler can schedule A, have the native side create A before the promise rejects, then blindly schedule B because its local success counter did not advance. The review reproduction reached 49 pending. Serializing complete passes does not fix this within-pass overflow. Both domains must use the authoritative-inventory recovery protocol in §5; changing Calendar's ambiguous-schedule/capacity handling is explicitly authorized, while its other behavior remains protected.

Two compatibility decisions follow from the actual code:

- **Completion disables intent today.** `setObligationCompleted(true)` sets `reminderEnabled=false`, retaining dueDate/time; the existing model test asserts this. Keep that behavior. Reopening alone therefore remains OFF. Reopening schedules only a row whose reminder is still explicitly configured: for example, the user edits a completed row to enable its reminder, then reopens it. A completed row never schedules. Do not infer enabled intent from a retained time or registry record. Tests must cover both the ordinary OFF reopen and configured future/past reopen.
- **Calendar tap routing is absent today.** Preserve its existing OS/default app-opening behavior and do not redirect Calendar payloads to Finance. A new Calendar event-opening feature is outside this brief. The requested Calendar tap regression means preservation of that audited baseline, not an invented existing route.

## 2. Product contract

One local notification, kind `due`, for any of payment/debt/receivable/purchase, only when the committed obligation is incomplete, reminderEnabled is true, dueDate/time exist and the converted instant is future. Default OFF, time suggestion 09:00. No advance, repetition, income reminder or server delivery.

- Removing dueDate must visibly turn OFF reminder intent and clear reminderTime in the SAME submitted Finance edit. Explain this next to the field; do not silently keep enabled intent or make the user discover it through a validation failure.
- Completing/deleting persists Finance first. Subsequent notification cancellation is independent and retryable. Reopen follows §1. Editing date, time, enabled state or title invalidates the desired request and triggers reconciliation.
- Saved obligations remain editable under notification failure. Domain save success closes only its own sheet, with existing guards; it must not be reported as a failed Finance save because reconciliation failed.
- Completion remains status-only. Scheduling, firing, tapping, cancelling and retrying never create expenses/incomes, change balance or rewrite an allowance. No CalendarEvent is created.
- Title `Workazy`; body `Финансовое напоминание · <title>`. Do not add amount, note or debt direction to content OR notification data. The user's own title may disclose information; retain the visible lock-screen warning. Do not mutate or truncate stored legacy titles to accommodate notifications; native content rejection is a reminder error.

## 3. Component boundaries and adapter choice

Choose **B: extract `expoLocalNotifications.ts`, retain a compatible `expoCalendarNotifications.ts` facade**. This keeps Calendar callers and tests stable while one module owns all Expo notification operations. No new dependency is planned.

Neutral pieces:

1. `localNotificationContract.ts`: existing normalized pending request, permission, trigger decoder/classifier, target key and tolerance constants, plus a low-level schedule request `{id, triggerAt, title, body, data}`. Move existing decoding logic without changing its semantics; re-export old public names from the Calendar contract where necessary.
2. `expoLocalNotifications.ts`: sole `expo-notifications` import; permission mapping/read/request, list, DATE schedule, individual cancel, foreground handler and response subscription/last-response read. Preserve current Calendar payload bytes/fields and foreground presentation. Stamp JS `scheduledAt` immediately before scheduling, as today; never claim it is a native timestamp.
3. `localNotificationReconcileQueue.ts`: one process-level FIFO queue for complete passes. Factory with injected jobs for tests; a single shared production instance. `localNotificationScheduleSafety.ts` supplies the shared pass-scoped inventory/capacity and ambiguous-schedule protocol (§5); both Calendar and Finance must consume it.
4. `notificationPermissionCoordinator.ts`: shared explicit-request single flight and permission publication, separate from the inventory queue.
5. `useLocalNotificationLifecycle.ts` and `notificationResponseRouter.ts`: root fanout and owner dispatch. No generic notification plugin framework.

Calendar-specific pieces remain: event types/storage, ownership/ID/payload conversion, body/fingerprint, start/advance planner, reconciler, registry, revision coordinator, controller results and UI. Its reconciler gets only the explicit scheduling/capacity safety adaptation in §5, not a generic rewrite. Finance adds its own obligation planner, ownership/matcher, reconciler, separate registry and controller. Finance must not call the Calendar planner with fabricated events or reuse its event registry.

Calendar facade adapts its current request to the neutral schedule request with the identical Calendar data fields. Finance contract builds its own data. Both delegate to the same native adapter. The adapter does NOT acquire the reconciliation queue: that would deadlock callers already inside a pass. Permission and response reads are not scheduling passes.

## 4. Finance identity, payload and persistent registry

Namespace `workazy.finance.v1`; owner `workazy-finance-v1`; deterministic ID `workazy.finance.v1:<obligationId>:due`. Preserve obligation IDs verbatim, including legacy IDs. Construct the canonical ID from payload fields; do not recover arbitrary obligation IDs by splitting on every colon.

Finance ownership requires the Finance owner, nonempty obligationId, kind exactly `due`, and identifier equal to that canonical Finance ID. A Calendar ID, conflicting owner, malformed identity or namespace-only match is not Finance-owned and must not authorize cancellation. Unknown requests still count toward capacity. This is an app bookkeeping/routing check, not authentication of an external sender. Calendar's existing predicate and emitted payload remain unchanged; Finance must never emit Calendar owner/event fields.

Payload fields: `{owner, obligationId, kind:'due', fingerprint, targetTriggerAt, scheduledAt}`. Both times are finite epoch milliseconds; target is the intended instant and scheduledAt is adapter call context. Use a deterministic unambiguous fingerprint over kind, dueDate/time, resolved trigger, exact title and body, for example a JSON tuple; money and notes are excluded. For tap validation, ownership/identity is required but an old fingerprint does not prevent opening a live edited obligation.

Proposed separate strict schema under **`workazy-native-finance-notifications-v1`**, version **1**:

```ts
type FinanceNotificationRecord = {
  id: string;                 // canonical namespace:obligationId:due
  obligationId: string;
  kind: 'due';
  fingerprint: string;
  targetTriggerAt: number;     // finite intended epoch milliseconds
  status: 'pending' | 'scheduled' | 'tombstone';
  scheduledAt?: number;       // observed adapter context; not native proof
  verifiedAt?: string;        // ISO instant of successful full inventory check
  createdAt: string;
  updatedAt: string;
};
type FinanceNotificationSnapshotV1 = {
  version: 1;
  records: readonly FinanceNotificationRecord[];
  savedAt: string;
};
```

`pending` is durable pre-schedule intent; `scheduled` records a successful full verification and requires scheduledAt/verifiedAt; `tombstone` means cancellation still needs durable confirmation. Clear old verification when replacing a target. Tombstones may retain earlier context. Store no amount/note/content copy; derive current content from the Finance domain. A fingerprint can contain the title and is local metadata, never telemetry.

Validate full envelope before write/publication: exact types/keys, timestamps, unique canonical IDs, due kind, finite supported targets/context, and status-specific fields. Publish immutable snapshots, serialize registry writes with their own gate, and keep committed registry unchanged on write failure. Notification registry writes never touch Finance revision or its envelope. Calendar V1 is untouched.

An absent key means empty registry: inspect OS and adopt fully matching Finance-owned requests or cancel obsolete positively owned requests. A corrupt/unknown-version/read-failed registry is a notification load-error: preserve original bytes, block Finance OS mutations and registry replacement, offer retry. A successful inventory read may explain what exists but does not authorize overwriting corrupt storage. Missing-registry recovery and corruption are distinct. No automatic reset/salvage UI in 6B; persistent corruption remains an honest blocked reminder state while Finance CRUD works. A corrupt/unhydrated Finance DOMAIN also blocks Finance reconciliation; never treat unknown obligations as an empty desired set and delete their reminders.

## 5. Global queue, capacity and fairness

All production Calendar and Finance reconciliation entry points use the SAME singleton queue, including focus, CRUD, retries and lifecycle. Enqueue a callback, not a previously captured snapshot. Inside the callback read latest hydrated domain/registry, revision, zone and clock, then perform the entire pass:

`permission read → inventory → desired/capacity → own cancellations → re-list → own scheduling → readback verification → registry finalization`

Hold exclusion across all awaits in that pass, including required registry writes. Release in `finally`; a rejected job must not poison subsequent jobs. Capture no stale inventory before acquiring the queue. Only the domain coordinator acquires it; neither OS methods, reconciler nor registry writer re-acquires it. Do not await another domain's reconciliation while holding it. An unresolved native call keeps the queue occupied; never release on a timeout and let the unresolved mutation race a second pass. Finance CRUD/navigation remain usable.

Narrow Calendar change: wrap EACH call to its existing reconciler in the shared gate inside `runCoordinatedReconcile`, moving the state/revision capture into the queued callback. Preserve the existing bounded 16-pass loop and result semantics. Release between reruns so queued Finance work can proceed. Preserve Calendar controller coalescing; Finance coalesces its own requests too. Do not wrap the whole controller plus the reconciler twice.

For startup, when both domains are ready enqueue Calendar then Finance. Hydrate independently; a failed/unready domain cannot stop the other from reconciling. A domain ready later joins the FIFO then. After startup use FIFO with at most one pending rerun per domain. Within Finance, earliest future trigger then deterministic ID; Calendar keeps its existing instant/eventId/kind ordering.

Capacity is **48 TOTAL pending OS requests**, counting Calendar, Finance and unknown/foreign. Each pass treats all other owners as foreign. Derive its own eligible window from `max(0, 48 - foreignCount)`. Never evict another owner to favor an earlier own request. After own cancellations, re-list and allocate only `max(0, 48 - currentPending.length)` new slots. A cancellation without confirmed absence frees no slot. Before EVERY new schedule, check capacity against the latest trusted inventory and any successful calls not yet reflected in it. Never reset occupancy to an older inventory after a readback error. The mandatory shared safety protocol below governs all uncertain outcomes.

This prevents two callers seeing 40 and each allocating 8. It does not promise globally earliest 48 or equal quotas. Existing foreign requests above 48 are retained: add none and report capacity; the app cannot promise to reduce someone else's inventory. Under an accurate native inventory and initially compliant occupancy, coordinated app scheduling must never increase total beyond 48. Foreground/focus/retry refills vacancies; no background refill/delivery guarantee.

### Shared ambiguous-schedule protocol — mandatory for Calendar AND Finance

Implement the protocol once in `localNotificationScheduleSafety.ts`, used by the current Calendar scheduling loop in 6B.1 and by Finance in 6B.2. A pass-scoped safety session owns the latest trusted pending set, its capacity accounting and whether new schedules are blocked. It receives injected OS list/schedule functions and exposes refreshed inventory plus typed outcomes (`verified`, `unverified`, `capacity`, `inventory-error`, `aborted`) to the domain reconciler. Domain ownership, full request matching, registry/tombstones and desired-order decisions stay domain-specific; pass the existing domain matcher to the verification step. Do not change Calendar trigger/fingerprint tolerances.

The session runs INSIDE the already acquired process-global queue. It never acquires that queue itself, never calls another domain, and never starts a detached recovery read. All scheduling in either domain passes through it; there must be no raw `os.schedule` fallback that bypasses its blocked state. The native adapter remains the sole Expo boundary.

1. Begin the pass under the shared queue, read actual pending inventory, and compute used/free capacity from the entire set. No successful initial read means no scheduling. After domain cancellation attempts, supply a fresh native list to the safety session; attempted cancellation alone cannot remove an item from its trusted inventory.
2. Before each schedule, require a trusted capacity state with space below 48, a still-current revision and a still-future trigger. Keep any successful, not-yet-verified schedule conservatively counted. Counts may assist normal bookkeeping, but cannot resolve an ambiguous native outcome.
3. If `schedule()` resolves successfully, consume its slot immediately, including when the returned ID is unexpected. Perform normal full native readback verification. A successful re-list becomes the new authoritative set and capacity is recomputed from it; do not double-count a request already present in that set. If verification fails, do not reuse the attempted slot unless a fresh successful native list proves it free. A mismatching request that remains present still occupies capacity and is handled through existing ownership/cancellation rules, not blind replacement. If the verification list fails, stop further scheduling and return a visible retryable error; retained occupancy is not permission to fall back to the pre-call count.
4. If `schedule()` throws/rejects, conservatively assume it MAY have created a request. Immediately block ALL further scheduling in this pass and await a native inventory re-read while still holding the same global queue. Do this even if the fake/native implementation appears to have thrown before insertion: promise failure is not evidence of absence. Incrementing/decrementing a local counter, assuming rollback, or merely catching/logging the exception is insufficient.
5. If that re-read succeeds, replace the trusted pending set, recalculate total capacity, and determine whether the attempted ID exists. When present, apply the unchanged full domain matcher: an exact current match can converge through ordinary verified bookkeeping, while a mismatch remains an occupied, unverified request. When absent, its slot is proven free. Only AFTER these decisions and fresh revision/time checks may scheduling resume in desired order. Attempt each candidate at most once per pass; a failed absent candidate may be retried on a later requested pass, avoiding an immediate retry loop. Other valid candidates may use capacity proved free by the recovery read.
6. If the recovery read fails, return `inventory-error`, abort further scheduling for the pass and publish visible retryable reconciliation error. Keep registry recovery intent, do not claim success or free capacity, and do not let the outer reconciler catch the error and continue its old scheduling loop. A later pass must acquire the queue and begin with a new successful native list. A stale revision also prevents scheduling resumption and instead requests a latest-state rerun after releasing the queue.
7. Successful OS scheduling followed by failed registry persistence does not release its slot or roll back the domain commit. Preserve native occupancy and reconcile from inventory on retry/restart. No recovery branch cancels Calendar/Finance/foreign requests merely to create space; only the domain's proven ownership and normal obsolete-request rules authorize cancellation.

For Calendar, replace the current `schedule` catch-and-continue/cached-capacity path with these typed outcomes and refreshed inventory accounting. Terminal inventory failure must exit its scheduling phase. Retain its durable prewrite, native matcher, tombstone rules, event revision guards, start/advance ordering and existing result/UI schema. A recovered exact match may yield capacity-limited success; otherwise surface the existing retryable error. Both outcomes must reflect native reality, never a fictitious free slot. This narrow correction is explicitly permitted in §10 and must land before Finance scheduling exists.

Capacity examples: 47 foreign + two desired requests allows at most one new request; 40 Calendar + 8 unknown leaves Finance zero slots. A cancellation frees capacity only after native re-list confirms absence. Failed cancellation or an item still present frees none. In the reproduced ambiguous A case, recovery sees 48, so B is not scheduled and A/foreign requests are not evicted to make room.

## 6. Finance reconciliation algorithm and stale work

Finance controller runs only when domain and registry hydration are ready. Subscribe to durable Finance publications: compare committed obligation reminder projection (ID/title/date/time/enabled/completed) to request work, ignoring saving/error-only publications and unrelated money changes. Any committed revision change still invalidates an in-flight pass. Register the subscription before loading, reconcile once hydration is ready, and avoid duplicate UI scheduling hooks.

1. Acquire shared queue; capture latest snapshot and `snapshot.revision`, registry, current zone/clock and a lifecycle generation. `shouldAbort` checks phase/revision/generation after awaits and immediately before mutations/publication. A zone or permission transition also requests a new generation/pass.
2. Read permission without prompting, then the ONE native inventory. A read failure produces retryable error with no guessed cancellations or new schedules. Derive eligible future requests plus per-obligation off/completed/past/unschedulable states. Sort and determine the window against foreign occupancy.
3. For positively Finance-owned obsolete/changed/completed/deleted/disabled/out-of-window requests, persist tombstone before cancellation, recheck revision, cancel individually, and re-list to confirm absence. Persist deletion of tombstone only after successful confirmation. Failed persist/cancel/list retains recovery intent and visible error; never count assumed free capacity. Cancel obsolete owned orphans by the same protocol.
4. With denied/revoked/unrequested permission, schedule nothing; clean owned pending with the same protocol, retain domain intent, and show the appropriate permission state. Provisional follows granted scheduling with quiet-delivery UI.
5. Re-list AFTER cancellations; calculate actual slots. Keep fully matching eligible requests without churn. Adopt matching owned requests absent from a valid/empty registry only after native verification and successful registry write. A registry record with missing native request is unscheduled, not success.
6. For missing eligible requests with capacity, persist `pending` intent first. Recheck committed revision, zone/generation and a fresh clock AFTER persistence, immediately before schedule. If target is now past, do not schedule; clean bookkeeping when safe and show past. If stale, abort and rerun.
7. Schedule through the shared safety session (§5), which delegates to the neutral adapter. Consume capacity immediately on success; require returned ID to match. On rejection, block further schedules, await the authoritative inventory re-read and recompute capacity before any continuation; failed recovery read terminates scheduling with retryable error. Re-list and check full native request (§7), then persist `scheduled` with observed context/verifiedAt. Prewrite failure prevents that schedule. Post-schedule write failure leaves the saved obligation and native request intact, reports error, and recovers by inventory on retry/restart. Never schedule a duplicate to compensate for a registry failure.
8. Final inventory/verification updates per-obligation results and confirms tombstone absence. Failed final list cannot be treated as empty or prove successful cancellation. Report capacity only for eligible requests actually excluded for lack of slots; verification/storage errors get error state, not a misleading capacity label. Publish only results still current for the captured revision/generation.
9. Release queue. If stale, coalesce and enqueue a latest-state rerun behind already queued work. Bound immediate reruns as Calendar does; keep a pending/error state after the bound and allow lifecycle/retry, rather than claiming convergence or spinning indefinitely.

An already-issued native schedule/cancel cannot be undone mid-await. If completion/delete/title edit commits while schedule is paused, the old OS call may land; reject its stale success and reconcile the newest state to cancel/replace it. Tests assert the converged result and lack of stale UI publication, not an impossible atomic transaction between Finance and the OS.

Registry persistence is not Finance persistence. A successfully saved obligation stays saved after permission, inventory, cancellation, scheduling, verification or registry failures. For a deleted item whose cancellation fails, show a Finance-level retry banner because its row no longer exists. Never roll back deletion or claim the old reminder was cancelled. Domain write failure must produce no notification mutation derived from its uncommitted draft.

## 7. Native verification, timezones and dates

Finance matcher requires deterministic ID; valid Finance owner/obligationId/due identity; current fingerprint; exact native title/body; finite exact `targetTriggerAt`; valid adapter `scheduledAt`; and a decodable native trigger. Reuse the current Calendar trigger classifier/decoder and shape-specific tolerances (absolute 2 s, interval handoff 30 s). Unknown or mismatched native trigger fails even with perfect metadata. Do not broaden Calendar matching or claim that a stored scheduled record proves present native state.

Use the existing pure `zonedDateTimeToUtcEarlier` directly; no second date converter or hardcoded Kyiv offset. Local dueDate/time stay unchanged during travel; a later pass resolves them in the CURRENT device timezone and safely replaces the UTC target. Capture zone at execution, not screen mount; foreground/active refresh detects changes. A timestamp that becomes past during awaits is never scheduled as immediate catch-up.

- Spring gap: no normalization to another hour. Save the obligation, mark the reminder unschedulable and offer date/time edit. Cancel an old owned target after a timezone change makes its local time nonexistent.
- Autumn fold: use Calendar's earlier occurrence. Do not switch to the later occurrence just because the earlier one is past.
- Support strict Gregorian 0001–9999 in the domain. Avoid year-0–99 JS constructor remapping. Unknown zone, conversion failure or actual native range rejection yields an unavailable/error reminder; do not change the stored date, silently drop the obligation or claim universal OS range support.
- Past trigger: leave obligation/overdue display intact, show past, never schedule null/immediate trigger. Pending notification verification proves scheduling at check time, not future delivery.

## 8. Permission and root lifecycle coordination

The neutral permission coordinator preserves current granted/denied/undetermined/provisional/ephemeral mapping and request options. Both Calendar facade and Finance controller delegate explicit requests to its one in-flight promise. Simultaneous button presses must cause one native prompt. A separate generation guards late permission reads so older undetermined results cannot overwrite a newer grant/denial; retain Calendar's latest-state merge behavior.

Permission prompts happen only from explicit “Включить уведомления”, never hydration, focus, retry, saving intent or foreground. Denied/cannot-ask-again offers Settings. Provisional means quiet delivery, not full alerts. A completed permission request publishes to both domains and enqueues reconciliation AFTER the prompt promise settles; it must not hold or await the inventory queue while another queued pass awaits that same permission promise. Inventory passes only read permission. Permission failure leaves prior known state marked unavailable/error, not fabricated denied/granted.

Root mounts one notification lifecycle and one foreground handler. Replace Calendar hook's ownership of notification AppState/timer wiring with neutral fanout; retain its exported Calendar hooks/commands and controller singleton. Do not mount both old root lifecycle and new lifecycle simultaneously. Preserve active-only 60-second Calendar refresh and actual initial AppState. Hydrate Finance at root for reminders even if its tab has never opened; existing FinanceScreen load remains idempotent. Loading does not initialize Finance or create a daily allowance.

Fanout on startup readiness, app active transition, active periodic refresh and Settings return refreshes both domains. Finance focus and explicit retry request its controller; relevant committed obligation changes request it regardless of tab. Finance's existing UI day hook/allowance establishment and sheet protections remain unchanged; do not add a separate Finance NOTIFICATION AppState listener. No background execution promise or new background task.

## 9. Finance UI and tap routing

Replace deferred copy in the obligation form with privacy help and actual reminder status. One existing Finance tab with its three sections remains. Status comes from the notification controller's verified results keyed by obligation ID and current desired fingerprint, not the domain intent flag or persisted registry alone.

| State | User-facing treatment |
| --- | --- |
| Off / completed | “Напоминание выключено”; completed items cannot schedule. Explain ordinary reopen keeps reminder OFF. |
| Not requested | “Разрешите уведомления” and explicit enable button; save remains available. |
| Checking/pending | “Проверяем напоминание…”; no success claim while hydrating or replacing old state. |
| Verified scheduled | “Напоминание запланировано” with local date/time; verification is for current desired state. |
| Provisional | If verified, “Запланировано · тихая доставка”; permission alone cannot produce scheduled status. |
| Past | “Время напоминания прошло”; allow date/time edit, keep overdue obligation. |
| Denied | “Уведомления выключены в настройках” plus Settings action. |
| Capacity | “Пока не запланировано — нет свободного места”; retry/foreground may refill. |
| DST/unsupported time | “Это время недоступно в текущем часовом поясе” or a specific unavailable-date message; edit date/time. |
| Retryable failure | “Обязательство сохранено. Не удалось обновить напоминание” with retry. Cancellation failure separately says the previous reminder may remain active. |

Off/completed describes intent, not confirmed cancellation; show any outstanding cancellation error alongside it. Error takes precedence over an obsolete scheduled badge. Provisional is permission context on top of scheduling state. Use existing tokens/accessible controls, no redesign or technical registry vocabulary in product UI. Notification publications never bump the Finance domain revision, replace drafts or close newer sheets.

One root response subscription plus cold-start last-response read delegates to a pure owner dispatcher. De-duplicate the same response from both entry points using request ID plus delivery/response identity (including notification timestamp/action), not deterministic ID alone across future deliveries. Register/clean up once; defer navigation until root navigation is ready. No arbitrary route from payload, notification inbox or action buttons.

Finance response sequence: verify canonical ownership/ID → await Finance hydration → re-read live obligation ID → navigate `/(tabs)/finance` → select Obligations → highlight the live row. Select completed history if the live target is completed. Highlighting is sufficient; do not force an editor over an unsaved sheet. Queue the UI intent until an existing sheet closes and recheck the entity then. If missing/deleted, show obligations list without an erroring editor. If Finance cannot hydrate, show its existing load-error/retry UI, not an invented empty dataset. A stale notification may safely open the current edited row; tapping has no financial side effects.

Calendar-owned responses never enter the Finance branch. Preserve baseline default app opening (no current custom Calendar target route). Unknown/malformed/conflicting-owner responses perform no domain navigation. Add a regression for this exact Calendar behavior; implementing a new Calendar tap-to-event route would require separate scope.

## 10. Exact allowed protected changes and proposed files

Paths below are relative to `mobile/`. This is a future implementation allowlist, not a claim that files exist or were changed.

| Files | Allowed work |
| --- | --- |
| ADD `src/services/notifications/localNotificationContract.ts`, `expoLocalNotifications.ts` | Neutral types/decoders, sole Expo adapter and response boundary. |
| CHANGE `src/services/notifications/expoCalendarNotifications.ts`, `calendarNotificationContract.ts` | Compatibility facade/re-exports only; identical Calendar ownership, IDs, payload, options and decoding. |
| ADD `src/services/notifications/localNotificationReconcileQueue.ts`, `localNotificationScheduleSafety.ts`, `notificationPermissionCoordinator.ts` | 6B.1: one queue singleton plus injectable factory, shared inventory/capacity/ambiguous-schedule safety session; permission single flight only as needed for the shared binding. |
| CHANGE `src/services/notifications/calendarReconcileCoordinator.ts` | 6B.1: gate each existing pass; sample latest state inside the gate. No generic reconciler rewrite. |
| CHANGE `src/services/notifications/calendarNotificationReconciler.ts` | 6B.1: replace only ambiguous schedule/cached-capacity continuation with the shared safety session and authoritative re-read protocol. Preserve ownership, storage, registry/tombstone, start/advance, revision, permission, trigger/fingerprint, DST and UI contracts. |
| CHANGE `src/features/calendar/calendarNotificationController.ts`, `useCalendarLifecycle.ts` | Only dependency/lifecycle/permission fanout adaptation if necessary. Preserve coalescing, revision reruns, today marker, error merging, API and UI behavior. |
| ADD `src/services/notifications/financeNotificationContract.ts`, `financeNotificationPlanner.ts`, `financeNotificationReconciler.ts`, `financeReconcileCoordinator.ts` | Finance identity/content/native matcher, pure desired requests, separate convergence protocol and revision coordinator. |
| ADD `src/types/financeNotifications.ts`, `src/storage/financeNotificationStorage.ts`, `src/services/notifications/financeNotificationRegistry.ts` | Strict separate V1 schema, injected storage and immutable registry factory. |
| ADD `src/features/finance/financeNotificationController.ts`, `useFinanceNotifications.ts` | Injected controller, stable UI subscription/commands; no direct Expo or AsyncStorage import here. |
| ADD `src/services/notifications/financeNotificationRuntime.ts` | Production binding for Finance registry AsyncStorage and controller dependencies. Keep storage imports out of additional Finance feature files. |
| ADD `src/services/notifications/useLocalNotificationLifecycle.ts`, `notificationResponseRouter.ts`; CHANGE `app/_layout.tsx` | Single root wiring, hydration/fanout and owner dispatch. No theme/tab changes. |
| CHANGE `src/features/finance/FinanceScreen.tsx`, `FinanceSections.tsx`, `FinanceSheets.tsx` | Verified status/retry/permission UI, explicit due-date removal behavior, focus and one-shot tap highlight. Retain sheet revision/identity checks and money commands. |
| CHANGE `src/types/finance.ts` | Comment-only removal of obsolete “intent only in 6A” wording, if needed. No domain fields/schema changes. |
| ADD/EXTEND `tests/finance-notifications.test.mjs`, `finance-notification-controller.test.mjs`, `finance-notification-storage.test.mjs`, `local-notification-coordination.test.mjs`, `notification-permissions.test.mjs`, `notification-routing.test.mjs` | Production-path tests and shared fake inventory coverage. Structural adapter/queue tests may extend existing Calendar test files without weakening their assertions. |
| CHANGE `tests/finance-wiring.test.mjs` | Replace obsolete deferral-copy assertion with active integration/boundary assertions; preserve no direct Expo scheduling in Finance feature files, no network/browser/API and singleton storage safeguards. |

Calendar planner, store, storage, types, Screen, date utilities and sheet guards require **no planned behavioral changes**. Calendar reconciler changes are explicitly allowed ONLY for ambiguous-schedule/capacity safety and consuming required shared infrastructure. Calendar event CRUD, storage schema, owner/IDs, start/advance semantics, native trigger/fingerprint verification, DST gap/fold/timezone policy, permissions, tombstones and current UI behavior remain unchanged. Do not edit them simply for generic naming. If an import-only re-export adjustment is unavoidable, identify it explicitly in the implementation diff; all existing contracts remain protected. Finance model/store/domain parser, money/aggregate/date/legacy adapter, operation forms, calendar projection and allowance/day machinery require no changes. No new package or app configuration is currently required by this design.

## 11. Two implementation checkpoints — later authorization only

### Slice 6B.1 — Shared notification safety infrastructure

Record baseline status/SHA, protected file hashes/diff list, and actual 472-test result before code changes. Preserve any unrelated user changes. Implement the neutral adapter/compatible Calendar facade, process-global full-pass queue, shared 48-total policy and `localNotificationScheduleSafety.ts`. Adapt only Calendar's ambiguous-schedule/capacity path and necessary coordinator wiring. Extract native inventory/readback primitives without altering domain verification. Shared permission coordination may be wired where required by the neutral boundary, retaining explicit-action-only Calendar behavior; it must not introduce Finance lifecycle/UI early.

Allowed 6B.1 production files are the neutral contract/adapter/queue/safety module, compatible Calendar contract/adapter, Calendar reconciler/coordinator, and Calendar controller/lifecycle or neutral permission coordinator ONLY as needed for this infrastructure. Keep root's current Calendar-only lifecycle unless a strictly necessary structural change is documented. Root Finance hydration, response routing, Finance registry/planner/reconciler/runtime/UI and Finance deferred-copy changes belong to 6B.2. Do not add a placeholder Finance scheduler in 6B.1.

Acceptance:

- Existing Calendar behavior and tests remain unchanged; add safety regressions rather than replacing or weakening existing assertions. Compatibility exports preserve current test imports. All 472 baseline cases, including Finance's deferred-scheduling assertion, remain green.
- Reproduce 47 foreign + native insertion of A followed by rejection; re-read sees 48 and B is not scheduled. Also pass every applicable §12.1 failure case.
- Two queued production Calendar reconciliation passes/controllers against ONE fake inventory cannot race capacity. Pause the first after list and while scheduling; the second cannot allocate concurrently. This tests the shared boundary without implementing a Finance planner.
- Foreign requests count toward capacity and are never evicted; uncertainty never permits stale-counter allocation. No Finance notification ID is scheduled or Finance reminder UI introduced.
- Run the applicable §13 verification and review protected diffs; no device success claim from tests/export.

**Gate: obtain an independent Codex review of the 6B.1 implementation and explicit REVIEW_OK before starting any 6B.2 implementation.** Passing tests or completing an implementation report alone does not satisfy this gate. Stop at the checkpoint for review; do not automatically continue into Finance notifications. This document defines that future gate; it does not claim REVIEW_OK for 6B.1.

### Slice 6B.2 — Finance notifications

Only after 6B.1 REVIEW_OK, record the reviewed infrastructure checkpoint and implement the Finance registry, desired planner, obligation reconciler/coordinator and controller. All Finance scheduling must consume the reviewed queue and safety session; no second capacity algorithm or independent Expo scheduler.

Add Finance local reminder UI/permission state, commit-driven completion/edit/delete/reopen cancellation/rescheduling, root hydration/lifecycle fanout, Settings return, Finance obligation tap routing and capacity-limited UX. Replace deferred copy/test assertions only now. Preserve Finance core and Calendar contracts described throughout this brief.

Acceptance: all Finance and actual cross-domain production-path tests in §12 pass against one shared fake native inventory, including concurrent Calendar + Finance at 47 pending and ambiguous failure on either domain. All protected baseline guarantees remain green; perform §13 checks and report actual implementation/native acceptance separately. No Slice 7 work.

## 12. Acceptance criteria and production-path test plan

Tests must execute the production adapter boundary/helpers, planners, stores, registry, queue, coordinators, controllers and response dispatcher with injected OS/storage/clock. UI tests must drive real components/helpers where applicable. Static wiring scans supplement behavior tests; no unused copy of the scheduler.

| Group | Required evidence |
| --- | --- |
| ONE inventory / cap | Start with 40 mixed/foreign requests; enqueue Calendar and Finance together. Pause the first pass inside list, cancel and schedule in separate tests. Assert second pass cannot inspect/allocate concurrently and every mutation trace stays at or below 48. Both use the same queue AND fake inventory; record max occupancy, not just final size. |
| Ownership | Real Calendar and Finance reconcilers never cancel each other's valid requests or foreign ones. Malformed/mismatched ID/owner/kind are rejected by Finance. Unknown requests consume slots. No cancelAll. Test 48 foreign and already-over-cap foreign inventory without deletion. |
| Topology/fairness | After cancellations, allocation uses a fresh list; failed cancellation still occupies a slot. Own earliest/stable ordering; combined startup order when both ready; FIFO/coalescing; a rejected job releases the queue, stale reruns do not starve the other queued domain. No nested acquisition. |
| Capacity failures | Schedule success plus failed readback consumes capacity. Schedule success plus failed final registry write leaves one pending request and no duplicate on retry. Ambiguous schedule rejection cannot grant an unverified free slot. Foreground after a fired/cancelled request refills safely. |
| Native truth | Registry scheduled/native missing reschedules only if future. Alter owner, ID, kind, obligationId, title/body, fingerprint, target, shape or native time and require mismatch. Test absolute strict/interval handoff/unknown shape through the shared production decoder; unchanged requests do not churn. |
| Registry/restart | Prewrite failure means no schedule. Post-schedule failure, restart with stale registry, missing registry plus matching OS request, obsolete owned orphan, failed cancel/list, failed tombstone removal and corrupt/unknown-version bytes. No lost domain writes, false success or foreign cancellation. Read-error/corrupt Finance domain blocks destructive cleanup. |
| Stale passes | Pause list/persist/schedule/cancel, then commit title/time edit, deletion or completion. Stale UI success never publishes; latest pass converges with no stale target. A trigger expiring during registry write never schedules. Registry writes do not bump Finance revision; newer unsaved sheets survive notification updates. |
| Obligation product | All four kinds, default OFF, required date/time, exactly one due alert, explicit dueDate removal commit-before-cancel. Completion disables intent and cancels; ordinary reopen remains OFF. Using real model/store, explicitly enable a completed row, then reopen: future schedules, past does not. No balance/operation/allowance effect from any notification path. |
| Permissions | No startup/focus/retry/save prompt. Simultaneous Calendar/Finance enable requests invoke native request once. Test denied, provisional, read/request failure, late stale read and Settings return refreshing both. Preserve Calendar delayed-result merge regressions. |
| Lifecycle | Finance reminders hydrate without opening the tab; one failed store does not block the other domain. Initial inactive/background state, active-only refresh, foreground, focus, committed changes, explicit retry and timezone refresh converge through the same production queue. No duplicate notification AppState registration. |
| Dates | Kyiv and Los Angeles gap/fold fixtures, UTC, timezone travel and return, fresh clock before OS scheduling, earlier-fold occurrence already past, invalid zone and native range failure. Domain years 0001/0009/0099/0100/9999 preserved; 0000/impossible dates rejected. |
| Tap/UI | Warm/cold live Finance tap, edited target, completed target, deleted target, hydration failure, duplicate response, later new delivery with same deterministic ID, existing unsaved sheet. Finance never routes Calendar; Calendar payload preserves current default app-opening behavior and never changes Finance selection. Unknown payload ignored. No scheduled badge before current native verification, including provisional/capacity/error cases. |

### 12.1 Mandatory ambiguous-schedule regressions

Use the real Calendar reconciler and the production shared safety module with injected fake OS/storage/clock. Keep existing Calendar test bodies/assertions unchanged and add these regressions to `tests/calendar-notifications.test.mjs`; queue tests belong in `tests/local-notification-coordination.test.mjs`. In 6B.2 exercise the same shared failure protocol through the real Finance reconciler too. Inspect operation order and maximum inventory size after EACH native mutation, not just the final count.

| Case | Required trace and assertions |
| --- | --- |
| Main Calendar regression: 47 foreign, A inserted then schedule rejects | `list(47) → schedule(A): native insert, rejection → recovery list(48)`. No schedule(B) before recovery or afterwards at capacity. Final and maximum pending count <=48; A is verified/accounted for or reported retryable, never blindly duplicated/cancelled. Result is capacity-limited or retryable according to inventory. All foreign items remain byte-for-byte unchanged; no incorrect owned cancellation. |
| A. Rejection before native insertion | Initial 47; schedule(A) throws without insertion. Recovery list is still REQUIRED and returns 47. One other valid future candidate may then be scheduled, ending at 48. Trace must prove recovery read precedes the next schedule; do not treat rejection itself as freed capacity or spin retrying A. |
| B. Successful schedule, failed verification/list | Initial 47; native adds A successfully, then readback list fails (also test content verification mismatch with A still present). Slot remains consumed and B cannot become the 49th request. Failed list yields retryable error and stops scheduling; a mismatching present request is still occupied. Only a fresh successful list proving absence may free the slot. |
| C. Ambiguous rejection AND recovery-list failure | Native inserts A then rejects; immediate re-read fails. No further scheduling calls in that pass, visible retryable error, durable recovery intent retained, no speculative free slot. Next requested pass begins with an authoritative read and safely converges. |
| D. Queued Calendar and Finance against 47 pending | 6B.1 tests two production Calendar passes with the shared queue. After 6B.1 REVIEW_OK, 6B.2 tests real Calendar AND Finance concurrently against ONE inventory; repeat ambiguous insertion/rejection on either domain. The second pass cannot list/allocate inside the first pass's critical section; combined maximum/final count <=48 with no cross-cancel. |
| E. Foreign capacity and cancellation proof | Unknown/foreign items consume slots and survive unchanged. 40 Calendar + 8 unknown leaves Finance zero slots. Successful confirmed own cancellation permits refill; cancel throwing or resolving while the item remains on native re-list frees nothing. No cancelAll or eviction of another domain. |

All these tests must exercise production-used safety paths. They must detect the old Calendar catch-and-continue behavior; the main regression must fail against the protected checkpoint's current reconciler. Do not add a duplicate safe scheduler only in test code.

Required outcome: real local reminders converge after durable Finance commits, preserve all protected core behaviors and Calendar semantics, keep one shared capacity policy, expose failure without falsifying financial data, and remain retryable after restart. Passing tests do not prove delivery.

## 13. Protected baseline and future verification

Before implementation record `git status --short`, `git rev-parse HEAD`, checkpoint `5a5486b4106b52e5372ba52e810d88ca01d2c629`, and hashes/diff-sensitive list of the audited Calendar files and existing Finance core. The checkpoint has 472 recorded tests, including the unchanged 362 pre-Finance baseline. Rerun and report actual baseline results before edits; do not copy this number as fresh verification.

Keep all 472 regression cases/guarantees green at both checkpoints. Existing Calendar tests/assertions stay unchanged; add the safety regressions without deleting or weakening any existing case, using compatibility exports to retain existing imports. In 6B.2 only, one Finance wiring case explicitly requires “Slice 6B” deferred copy: this is a temporary scope assertion contradicted by the newly authorized implementation, not a permanent prohibition. Replace only that temporary assertion/name with production integration coverage while retaining its direct-Expo boundary checks. Keep the completion-disables-intent model assertion unchanged. Document any structural test changes individually, never reduce coverage to obtain a green suite.

After future code implementation run mobile `npm test`, the suite with `TZ=Europe/Kyiv`, `TZ=America/Los_Angeles`, `TZ=UTC`, `npm run typecheck`, `npm run lint`, full ESLint, Expo dependency check/Doctor, iOS export, root `npm run build`, and `git diff --check`. Report actual results and pre-existing warnings/blockers separately. Inspect diff for protected files, duplicate Expo imports/lifecycle wiring, HTTP/browser/backend imports and cross-owner cancellation. No tests/build/native results are claimed by this architecture task; its requested verification is `git diff --check` and a documentation-only scope check.

## 14. Native iPhone acceptance — PENDING

- [ ] First launch with existing Calendar/Finance data: no unsolicited permission prompt; reminders reconcile without opening Finance; no duplicate alerts after termination/restart.
- [ ] Explicit permission prompt, denial, provisional quiet mode and Settings return observed for both domains; no simultaneous double prompt.
- [ ] Near-future obligation notification delivered once with correct local date/time and privacy-conscious content; Calendar start/advance behavior still observed unchanged.
- [ ] Edit title/date/time; turn OFF/remove date; complete/delete/reopen; verify native cancellation/rescheduling and honest UI under failures. No change in Finance money/allowance.
- [ ] App foreground/background/terminated and warm/cold taps: correct Finance target/list, completed/deleted targets, no Calendar misrouting or discarded sheet.
- [ ] Shared capacity pressure/refill, native inventory shape/timing, timezone travel, gap/fold and unsupported dates observed where reproducible. Do not equate mocks with native evidence.
- [ ] Lock-screen privacy copy, keyboard-safe forms, accessible status/retry/Settings controls, VoiceOver, Dynamic Type, compact/notched iPhone layout.

OS delivery depends on device settings and execution opportunities. Existing pending iPhone acceptance remains pending until observed; export or unit tests cannot clear it.

## 15. Explicit exclusions and this task's output

No server push/APNs backend, Firebase, Telegram, web reminder API, GitHub Actions reminders, background delivery service, recurring obligation generation, advance Finance reminder, repeating nag, income notification, inbox, bank integration, FX, Finance cloud sync or import/export UI. No Slice 7 polish/onboarding/settings expansion, new tab, Calendar redesign, web/backend contract change or Plans/Journal/Media/Ideas behavior change.

This architecture task changes **only `tasks/current-task.md`**. It does not implement Slice 6B, modify mobile production code, change MASTER_PROMPT.md, claim native acceptance, deploy or commit.
