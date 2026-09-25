# Design: Background Concurrency, Queue, Agents TUI, and Push Delivery

## Overview

Three small additions around the unchanged 002 execution primitive:

1. A **slot semaphore + FIFO pump** in `SessionManager` gates child-creation
   start; the existing queued → running → terminal pipeline runs unmodified
   once admitted.
2. A **TUI presenter and invocation observer** derive process-local rows and
   drive one custom widget per parent namespace, with terminal visibility
   controlled at parent input boundaries.
3. A **completion notifier** seam delivers a hidden terminal completion signal
   via `pi.sendMessage` follow-up; the full result is fetched via
   `subagent_output` and rendered in its tool result region.

```text
src/
├── config.ts                      # + maxConcurrentSubagents layer case (S1–S2)
├── types.ts                       # + field on MinimalSubagentsConfig
├── index.ts                       # input-source filtering at the host boundary
└── runtime/
    ├── agent-runner.ts            # confirmed per-invocation widget accounting
    ├── session-manager.ts         # slots, FIFO, visibility, notifier/view hooks
    ├── agents-view.ts             # row derivation, text tree render, widget lifecycle
    └── completion-notify.ts       # AsyncCompletionNotifier seam + host adapter
```

## Components

### Config (`config.ts`, `types.ts`)

- Add `maxConcurrentSubagents: number` to `MinimalSubagentsConfig`
  (required at the type level; `DEFAULT_CONFIG` sets `8`).
- Add one `case "maxConcurrentSubagents"` in `applyLayer` beside
  `historyRetentionDays`: safe integer, range 1–64, else
  `warn('Ignoring invalid "maxConcurrentSubagents" in ${path}: expected a safe integer 1-64.')`
  keeping the lower-precedence value. No new loader machinery; frozen-object
  and layer semantics are untouched (satisfies S1–S2).

### Slot semaphore and FIFO pump (`session-manager.ts`)

- Manager gains `private readonly maxConcurrent: number` captured from
  `options.config.maxConcurrentSubagents ?? 8` at construction (the `?? 8`
  covers configs built before this feature; production always passes the
  effective config), plus `private runningSlots = 0` and
  `private readonly waiters: string[]` (session IDs in S5 order; insertion
  keeps the array sorted by `created_at`, then `session_id`).
- **Admission gate placement (D1 — gate child creation, not acceptance):**
  `executeNew`/`executeResume` currently start child creation right after the
  queued write. The gate is inserted there: after the queued write succeeds
  and publishes, if `runningSlots < maxConcurrent`, take a slot and proceed
  exactly as today; otherwise register the record in `waiters` and return a
  promise that resolves at admission. The existing per-record shutdown-signal
  race wraps the wait, so shutdown of a waiting record resolves the waiter
  immediately into the S8 aborted path (no child is ever created for it).
- **Pump (D2 — synchronous release+admit):** a `private pump()` method runs
  synchronously whenever a slot releases (terminal `persistTerminal` success,
  process-local terminal retention, shutdown settlement) or a waiter is added:
  while `runningSlots < maxConcurrent` and `waiters` is non-empty, shift the
  head and resolve its admission gate. Because JS runs `pump()` to completion
  without yielding, release+admit is atomic (satisfies N2/S5).
- **Background callers:** every `new`/`resume` returns its queued acceptance
  promptly; with the gate inside the execution, queued callers naturally wait
  for admission in background. No caller holds a slot while waiting; each keeps
  its S5 queue position.
- **Resume interplay:** the S9 per-record reservation is acquired before
  queueing as today; a reserved-then-waiting record still rejects competing
  resumes with `SESSION_BUSY`. The slot is taken only at admission, so a
  waiting resume blocks only its own slot, never another session's turn.
- **Shutdown (S8):** `finishShutdown` partitions active records: waiting
  (never started a child, `child === undefined`) settle via the new
  `settleQueuedShutdownRecord` — mark, persist/publish `aborted` with
  `PARENT_SHUTDOWN`, preserve nothing (no output/usage can exist), run the
  normal post-terminal cleanup path, resolve the waiter; started records use
  the existing `settleShutdownRecord`/abort barrier unchanged. Admission is
  already closed, so `pump()` is not run during shutdown.
- **Status/output (S10):** no changes needed — waiting records already read
  as `queued` and sort correctly under 002 S29. `waiters` order and status
  order coincide by construction (both `created_at`, `session_id`).

### Parent operation abort (`index.ts`, `session-manager.ts`)

- **D7 — retain one listener per host operation signal:** the tool boundary
  passes every `subagent_call` `AbortSignal` to a manager binding method before
  mutation. A `WeakMap<AbortSignal, Binding>` deduplicates repeated tool calls
  from one parent operation without strongly retaining completed un-aborted
  signals. Each binding tracks the parent namespaces observed under that
  signal; its once-only listener starts namespace abort for each tracked
  namespace. An already-aborted signal takes the same path synchronously and
  prevents the requested call from mutating state.
- `SessionManager.abortActive(context)` selects non-terminal queued/running
  records in only that namespace, marks/cancels waiting admission, calls the
  existing idempotent child abort request for started records, and settles both
  paths through the existing `aborted` publication, slot-release, view-refresh,
  and completion-notification machinery.
- Unlike `shutdown`, operation abort does not set `NamespaceState.closed`, does
  not await unrelated preparation/drain barriers, and does not prevent a later
  independent operation from admitting new work. Shared record-level abort and
  settlement guards make natural completion and concurrent shutdown races
  exactly-once.

### Widget rows and invocation usage (`agent-runner.ts`, `session-manager.ts`, `agents-view.ts`)

- `agent-runner.ts` keeps per-`prompt` pending and confirmed input/output
  counters. Assistant `message_end` accumulates only `usage.input` and
  `usage.output`; assistant `turn_end` commits those counters, increments the
  invocation turn count, and publishes progress. This preserves the prior
  coherent snapshot while a later turn streams and naturally resets on resume
  because every `prompt` call creates fresh local counters.
- `ChildExecutionObservation.widgetUsage` is process-local and is never copied
  into `StoredUsage`. `SessionManager` maps it only into `AgentViewRow`.
- Each record has process-local `widgetVisible`. Acceptance/resume sets it true;
  settlement leaves it true. `onParentInput(context)` hides only terminal
  records in that namespace and refreshes/disposes its view. The index-level
  host input hook calls this method only for `interactive` and `rpc` sources.
- `agents-view.ts` renders the approved two-line tree and compact token counts.
  Terminal elapsed time is frozen at `completed_at - created_at`; active time
  continues from the manager clock. Existing spinner and 5-second refresh
  intervals remain and are cleared on disposal. The former 10-second timeout,
  timer map, and constant are removed.

### Completion notifier (`completion-notify.ts`)

- **D5 — injected seam, host adapter at the edge:**
  ```ts
  export interface AsyncCompletionNotifier {
    notify(signal: { sessionId: string; status: string }): void | Promise<void>;
  }
  ```
  `SessionManagerOptions` gains optional `notifier?` (tests inject a fake;
  default is a no-op when no host surface exists). The production adapter
  `createHostNotifier(pi)` injects the minimal S18 signal into model context
  via `pi.sendMessage({ customType, content,
  display: false, details }, { triggerTurn: true, deliverAs: "followUp" })`,
  where `content` names the session and status and instructs a
  `subagent_output` fetch, and `details` is exactly
  `{ session_id, status }`. No `ui.notify` call is made and no message
  renderer is registered; no entry renderer is registered and no `turn_end`
  hook appends entries (there is no foreground execution to report). The
  fetched full result renders as `« Agent Output · <agent>` (or the safe
  error form) inside the `subagent_output` tool result region, and the host's
  global expansion state adds bounded, sanitized output or safe error/status
  details. The verified `convertToLlm` implementation maps `custom`-role
  `content` into LLM `user`-role context regardless of `display`, so the
  hidden signal still reaches the model. No synthetic tool result is added
  to work around host limitations.
- **Wiring:** the manager needs the host `pi` object, composed at activation
  (`SessionManagerOptions.pi`). If no `pi` surface and no injected notifier
  exist, the record's notifier is the no-op and only polling serves
  completion — still spec-compliant delivery-degraded behavior with a fixed
  redacted warning.
- **Fire points:** after terminal publication in `persistTerminal` (covers
  completed/failed/stopped for every background record) and after publication in
  the shutdown settlement paths for background records.
  The notifier receives the minimal `{ sessionId, status }` signal; notifier
  rejection → one fixed redacted warning (`ASYNC_PUSH_WARNING`), no retry,
  no record mutation (S20). Firing is non-blocking: the execution promise
  does not await delivery (S21 ordering holds because publication precedes
  the fire call).

## Decisions

### D1. Gate child-creation start, not acceptance

Acceptance (persisted `queued` + immediate return) is the 002 polling
contract and stays latency-free; only resource consumption (child sessions)
is gated. This also keeps `created_at`-based FIFO meaningful.

### D2. Synchronous pump, no fair-scheduling machinery

JS single-threading makes a synchronous release+admit loop atomic without
locks, queues, or timers. No priority, no starvation handling beyond FIFO.

### D3. View derives from existing observable state

No new child-event subscriptions (the observer stays assistant-`turn_end`
only per C4) and no snapshot schema changes; turns/tools already arrive via
`usage`. Queue position comes from the manager's `waiters` order.

### D4. Per-namespace presenter holding the latest host UI handle

`setWidget`/`requestRender` handles belong to a parent session's UI; keying
presenters by namespace preserves 002 namespace independence and avoids
cross-talk between parent sessions.

### D5. Notifier seam with host adapter and visible renderer at the edge

The manager never imports host UI/message types directly; the adapter does.
Tests inject fakes, keeping manager unit tests host-free and preserving the
"no new dependencies" constraint.

### D6. Process-wide (not per-namespace) slot pool

Resource protection targets the extension process; per-namespace pools would
admit `namespaces × limit` children. FIFO spans namespaces; namespace
independence is preserved for shutdown/visibility/loading, only slot
contention is shared — stated in spec S4 and surfaced in tasks tests.

### D7. Bind the parent operation signal beyond prompt tool return

`new` and `resume` return queued acceptance before background execution ends,
while the host reuses the agent-loop abort signal across the parent operation.
A listener removed when `execute` returns would therefore miss the later user
abort. One weakly keyed listener per signal preserves cancellation for prior
background calls without accumulating one listener per tool invocation.

## Failure Handling

- Queued-write failure before admission: existing 002 behavior (record
  removed for `new`, prior terminal kept for `resume`); waiter never
  registered, `pump()` unaffected.
- Child-creation/prompt failure after admission: existing terminal-`failed`
  path; slot releases in the same synchronous block that publishes terminal
  state, then `pump()`.
- Terminal-write failure: process-local terminal retention (002 S40/S32);
  slot still releases and `pump()` still runs — the slot guards live
  execution, not durability.
- Shutdown waiting records: aborted without child creation (S8); waiter
  promise resolved, never left pending (no floating promises per 002 N7).
- Push failure: fixed redacted warning, no retry, record untouched (S20).
- View render/interval failure: fixed redacted warning; both intervals are
  cleared on dispose so no timer leaks.

## Host Limitation

`setWidget` handle lifetime and `sendMessage` follow-up rendering belong to
the host; if the host drops a widget handle or a follow-up message, the
extension cannot detect it — polling remains the recovery path (R6). Exact
host method/option names are confirmed against the installed 0.84.2 typings
at implementation time.
