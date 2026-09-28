# Specification: Background Concurrency, Queue, Agents TUI, and Push Delivery

Extends `002-subagent-runtime` (S6, S22–S50) and `000-foundation` config
(S8–S16). All 002/003 contracts not amended below remain in force.

## Configuration

```ts
interface MinimalSubagentsConfig {
  historyRetentionDays: number; // unchanged
  defaultModel?: string;        // unchanged
  defaultThinking?: ThinkingLevel; // unchanged
  maxConcurrentSubagents: number;  // NEW: default 8
}
```

- **S1:** `maxConcurrentSubagents` defaults to `8`. A present value must be a
  safe integer in range 1–64; an invalid value warns (path, field, reason; no
  values leaked) and keeps its lower-precedence value, mirroring 000
  S11/S14. Unknown fields keep existing warn-and-ignore behavior.
- **S2:** Layering is unchanged: built-in defaults → valid global fields →
  valid project fields, merged per field; the effective config is frozen and
  loaded once per activation. A config change takes effect on next activation;
  in-flight and queued executions keep the limit instance they were admitted
  under (the `SessionManager` captures `config` at construction, as today).
- **S3:** `maxConcurrentSubagents: 1` is valid and serializes all execution;
  FIFO order guarantees still hold.

## FIFO Concurrency and Queueing

- **S4:** A process-wide slot semaphore caps simultaneous child executions at
  `maxConcurrentSubagents`. A record holds a slot from child-creation start
  through terminal settlement (persisted terminal write, process-local
  terminal retention on write failure, or shutdown settlement). Records in
  `queued` persistence that have not started child creation hold no slot.
- **S5:** FIFO admission order is `created_at` ascending, then `session_id`
  ascending, across `new` and `resume` equally. Slot release and next-record
  admission run in one synchronous pump with no intervening yield; no
  lower-order record may overtake a waiting record.
- **S6:** Background acceptance is unchanged in shape: the persisted `queued`
  snapshot copy returns immediately (with the S5 warning for `new`), whether
  or not a slot was available. Admission only changes when execution starts:
  `running` persistence and child creation occur at admission time, not at
  acceptance time.
- **S7:** There is no synchronous execution: every `new`/`resume` returns its queued acceptance promptly and completes in background. A waiting caller holds no slot while queued; its queue position follows S5.
- **S8:** Cancellation/shutdown of queued-not-started records: namespace
  shutdown marks waiting records, settles each as `aborted` with the exact
  002 `PARENT_SHUTDOWN` error, persists and publishes the aborted snapshot
  (retention cleanup follows the normal post-terminal path), and never
  creates a child for them. Started records follow the existing 002
  S45–S50 barrier unchanged.
- **S9:** Closed-namespace admission (after shutdown begins) still fails
  before mutation with `INTERNAL_ERROR` "The parent session is shutting
  down." for `new`, `resume`, and `steer`.
- **S10:** Status and output during queueing: a waiting record reads as
  `queued` from `subagent_output` and appears in `active_sessions` ordered by
  the existing 002 S29 rule (`started_at ?? created_at`, then `session_id`;
  waiting records have no `started_at`, so queue order matches S5 order).
  No new status fields are introduced.

## Agents TUI Data and Visibility

- **S11:** Every visible record exposes a row containing its agent name,
  deterministic task label (the optional `label` override when supplied,
  else the first non-empty prompt line; collapsed whitespace,
  truncated to 60 characters with `…`), elapsed duration, terminal status when
  settled, and process-local invocation statistics. The statistics begin as
  `0 turns · — in / — out`. At each assistant `message_end`, only
  `usage.input` and `usage.output` are accumulated; cache fields are excluded.
  The coherent values are published with the corresponding assistant
  `turn_end`. An in-progress next turn keeps the prior confirmed values.
  Every resume resets these widget counters to zero.
- **S12:** Terminal rows remain visible without a time limit until the next
  qualifying parent input event. At that boundary, only records already
  terminal in that parent namespace become hidden; queued/running records stay
  visible and may settle visibly afterward. Interactive and RPC input qualify;
  extension-sourced input does not. Resume makes the same record visible again.
- **S13:** The widget mounts when the first visible execution is published and
  disposes when no visible rows remain. Shutdown-aborted rows follow the same
  boundary visibility rule. Non-TUI execution remains unchanged.
- **S14:** The header is `› Agents · N working · N finished`, using the
  current visible active and terminal row counts respectively; both numeric
  counts use `dim` theme styling. Each record renders two tree lines. The first
  is `branch marker agent · label · elapsed`; active rows use the animated
  spinner and terminal rows use `✓`
  (completed), `✕` (failed), yellow `■` (stopped), or dim `■` (aborted). The
  second is `› N turn(s) · X in / Y out`, indented with `│    ` for non-final
  rows and five spaces for the final row. Token counts below 1000 are integers;
  larger values use one-decimal `k`/`M`, dropping `.0`.
- **S15:** Lifecycle transitions and the existing unreferenced 5-second elapsed
  refresh request rendering; the unreferenced 80ms timer advances only spinner
  presentation. Disposal clears both timers. There is no terminal linger timer
  or linger constant. Render failures remain fixed-warning and non-fatal.
- **S16:** Parent input hooks are registered at the extension index boundary,
  filter by the host `InputEvent.source`, and neither transform nor handle the
  input. Namespace visibility and all widget statistics are process-local only.

## Push Delivery of Terminal Background Output

- **S17:** Exactly one push fires per background execution (`new` or `resume`)
  upon its terminal settlement — persisted terminal states
  `completed`, `failed`, `stopped`, and shutdown-`aborted` alike. Resume
  pushes under the resumed (same) `session_id`.
- **S18:** The push is a hidden completion signal carrying only the session
  identity and terminal status: `details` is exactly `{ session_id, status }`
  and `content` is the one-line settlement notice plus a concise instruction
  to call `subagent_output` for that `session_id`. The signal never carries
  child `output`, `error`, `usage`, `model`, or thinking. No timestamps,
  metadata, or warnings are added. The main agent retrieves the authoritative
  full result via `subagent_output` (C5). The injected message sets
  `display: false` so no transcript row or toast is shown, while remaining
  fully present in model context. No completion message renderer is
  registered and there is no foreground UI-only entry renderer. The fetched
  full result renders as `« Agent Output · <agent>` (or the safe `✕` error
  form) inside the `subagent_output` tool result region, with global host
  expansion (`Ctrl+O`) showing sanitized actual output, or safe terminal
  error/status information when output is absent. No `ctx.ui.notify` call is
  made.
- **S19:** Delivery mechanism is a single hidden message via
  `pi.sendMessage({ customType, content, display: false,
  details }, { triggerTurn: true, deliverAs: "followUp" })` where `content`
  and `details` are the minimal S18 signal. No renderer is registered for
  that custom type.
  `onUpdate` is never used after `execute` returns (C2). Polling the
  terminal record remains available as fallback (R6).
- **S20:** Delivery is best-effort and side-effect-free on records: a failed
  `sendMessage` emits one fixed redacted warning, does not mutate or
  repersist the record, does not retry, and does not change the terminal
  snapshot. Polling the terminal record afterwards returns identical data.
- **S21:** Push ordering guarantee is per-session only: a session's push
  fires after its terminal snapshot is published (persisted-write success or
  process-local retention path), so an immediate `subagent_output` poll in
  the follow-up turn observes the terminal state. No cross-session ordering
  is promised.
- **S22:** Shutdown-`aborted` background records push exactly like natural
  terminal records (signal status `aborted`; the `PARENT_SHUTDOWN` error
  remains readable via `subagent_output`), fired from
  the shutdown settlement path after publication.

## Compatibility

- **S23:** `subagent_output` and the session portions of `subagent_status`
  keep their exact 002 shapes, ordering, and field sets; no fields are added
  or removed. A later `subagent_output` poll returns the authoritative full
  result identified by the S18 signal.
- **S24:** No storage migration: queue position, labels, phases, slot
  ownership, and push state are process-local only and never persist. The
  003 envelope/schema validators accept and reject exactly what they do
  today.
- **S25:** No new public tools, error codes, or host modifications, and no `async` tool parameter. No new production dependencies.
- **S26:** Background completion is only the existing custom follow-up
  message. There is no foreground Agent Output entry: queued background
  acceptance and later background completion never append a custom entry.

## Parent Operation Abort

- **S27:** If the host `AbortSignal` supplied to any `subagent_call` execution
  aborts, every non-terminal queued or running record in that call's parent
  namespace is marked for abort. This includes background executions accepted
  by earlier `subagent_call` invocations. Records in other namespaces are not
  affected.
- **S28:** Queued-not-started records abort without creating a child; started
  records receive child `abort()`. Both paths publish the existing terminal
  `aborted` snapshot with `PARENT_SHUTDOWN`, retain the existing exactly-once
  completion signal, and release any held concurrency slot. No new public
  result shape, error code, or persisted field is introduced.
- **S29:** An already-aborted signal triggers the same namespace-wide abort
  before the call performs new mutation. Repeated abort notification, natural
  terminal settlement, and concurrent `session_shutdown` are idempotent and
  must not double-abort, double-publish, or leak admission waiters.
- **S30:** The tool boundary binds each host operation signal once and
  associates every parent namespace observed under that signal. Repeated
  `subagent_call` executions using the same signal do not add duplicate
  listeners. The binding remains effective after a prompt background call has
  returned, fires once on operation abort, and is garbage-collectable when the
  host releases an un-aborted signal. Abort handling is best-effort and does
  not replace the existing full `session_shutdown` close-and-drain contract;
  operation abort does not close the namespace, so a later independent call
  may be admitted.

## Acceptance Criteria

- **A1:** With `maxConcurrentSubagents: 2`, three concurrent background executions
  run at most two children simultaneously; the third remains `queued`,
  polls as `queued`, appears in `active_sessions`, then runs to terminal and
  pushes exactly once with a hidden signal identifying its `session_id` and
  status, whose full result is readable via a later `subagent_output` poll.
- **A2:** FIFO order: admission order of waiting records matches `created_at`,
  then `session_id`; a later-created record never starts before an earlier
  waiting record while a slot is held.
- **A3:** A `new` issued while all slots are held returns its queued acceptance promptly, waits in queue position, then runs to terminal and pushes exactly once.
- **A4:** Namespace shutdown settles queued-not-started records as `aborted`
  with `PARENT_SHUTDOWN` without creating children, still aborts/drains
  started records per 002, and pushes once for each background record settled by
  the shutdown.
- **A5:** The Agents widget renders the count header and two-line rows with
  compact confirmed invocation usage. Terminal rows persist indefinitely,
  are hidden only by a later interactive/RPC input in their namespace, and
  reappear on resume; running rows survive such a boundary and later settle
  visibly. Disposal clears both recurring timers, and non-TUI behavior is
  unaffected.
- **A6:** Invalid `maxConcurrentSubagents` (0, 65, 2.5, `"8"`) warns and
  preserves the lower-precedence value; default with no files is 8.
- **A7:** Polling contracts are byte-compatible with 002: output/status
  shapes, ordering, and summary-only status fields are unchanged, and every
  terminal push signal identifies a session whose later poll projection
  carries the full result.
- **A8:** The injected push message is hidden (`display` is `false`, no
  toast), stays in model context so the main agent reacts immediately, and
  carries only the session identity, terminal status, and a `subagent_output`
  fetch instruction. The fetched full result renders as a compact
  `Agent Output` row inside the `subagent_output` tool result region and
  expands to output/error/status safely. No foreground custom entries exist.
- **A9:** Aborting one `subagent_call` host signal settles every queued and
  running background record in that parent namespace as `aborted`, creates no
  child for queued records, calls `abort()` for started children, publishes
  each terminal state/completion signal once, and leaves another namespace and
  later calls in the original namespace unaffected. Already-aborted signals,
  repeated calls sharing one signal, natural-settlement races, and concurrent
  shutdown complete without duplicate effects or listener/waiter leaks.
