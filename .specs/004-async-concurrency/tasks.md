# Tasks: Background Concurrency, Queue, Agents TUI, and Push Delivery

Scope: implementation only; no host modifications, no new production
dependencies, no storage migration, no new tools or error codes.

## T1. Config surface

- [x] Add `maxConcurrentSubagents: number` to `MinimalSubagentsConfig`
  (`src/types.ts`); set `DEFAULT_CONFIG` to `8`.
- [x] Add the `applyLayer` case in `src/config.ts` (safe integer 1–64,
  warn-and-keep-lower-precedence, no values in warnings).
- [x] Add config matrix tests (default 8 with no files; global/project
  layering per field; invalid 0/65/2.5/`"8"`/NaN warn and preserve).

Satisfies: S1–S3 (partial), A6

## T2. Slot semaphore and FIFO pump

- [x] Capture `maxConcurrent` in `SessionManager` construction; add
  `runningSlots`, `waiters`, admission gate in `executeNew`/`executeResume`,
  synchronous `pump()` on release/admit.
- [x] Release slots on all terminal paths (persisted write, process-local
  retention, shutdown settlement) in the same block that publishes state.
- [x] Add tests: limit enforcement (2 slots / 3 background executions, third stays queued);
  process-wide FIFO across two namespaces with an equal-`created_at`
  `session_id` tie, mixed new/resume ordering, and `maxConcurrent: 1`
  serialization; queued callers return promptly without holding a slot and every settlement pushes.
- [x] Verify slot behavior for queued-write rejection (no slot acquired),
  running-write failure, child-creation failure, prompt rejection,
  terminal-write failure, and shutdown releasing a slot to another namespace.

Satisfies: S4–S7, S10, A1–A3

Depends on: T1

## T3. Queued shutdown path

- [x] Partition shutdown into waiting (settle `aborted` + `PARENT_SHUTDOWN`
  without child creation, waiter resolved, normal cleanup path) vs started
  (existing barrier unchanged); never run `pump()` during shutdown.
- [x] Add tests: queued-not-started settles aborted with zero child-factory
  calls; closed-namespace admission still rejected; waiting waiter promises
  never left pending; mixed waiting+started namespace settles all.

Satisfies: S8–S9, A4 (partial)

Depends on: T2

## T4. Labels, phases, and Agents view

- [x] Implement `src/runtime/agents-view.ts`: `deriveLabel` (S11 60-char
  rule), `derivePhase`, `formatElapsed`, text-tree `render`, per-namespace
  presenter with mount/refresh/dispose + 5s data ticker, no-op when `setWidget`
  is absent. Mount on first accepted active execution;
  every background settlement pushes.
- [x] Refine presentation using the `setWidget` factory's public `Theme`:
  count header, themed two-line content, animated spinner on a separate 80ms
  render-only timer, and exact final/non-final connectors. Clear and unref
  both timers on disposal.
- [x] Store accepted trimmed prompt as process-local `taskLabel` on
  `LiveRecord`; hook `refresh()` into acceptance/admission/progress/
  terminal/shutdown publication; dispose when a namespace has no visible rows.
- [x] Add tests: label derivation matrix (multiline, long, whitespace);
  exact unstyled semantic output and fake-theme rendering; singular/plural
  count and turn labels; final/non-final connectors; deterministic spinner
  advancement without row recomputation; both-timer disposal; mixed
  TUI/non-TUI lifecycle; non-TUI no-op; render-failure warn-only.
- [x] Refresh an existing namespace view even when the transitioning call has
  no `ui.setWidget`; require `setWidget` only to create a view. Shutdown
  settles rows through the same refresh path so shutdown-`aborted` rows remain
  visible until a qualifying input boundary.
- [x] Keep unpublished new/resume reservations in the FIFO waiters list, but
  exclude them from widget rows and mount decisions until queued persistence
  succeeds; refresh after publication and restore a failed resume's prior
  terminal visibility. Add gated/rejected queued-write tests for both actions.
- [x] Add manager integration coverage proving terminal outcome markers remain
  visible through time and the widget disposes with both recurring timers
  stopped at the next qualifying input boundary.
- [x] Isolate spinner-triggered `requestRender` failures with the fixed redacted
  warning, emitted at most once, and add deterministic fake-timer coverage for
  non-throwing ticks and disposal.

Satisfies: S11–S16, A5 (partial)

Depends on: T2 (hooks), T3 (shutdown settlement paths)

## T5. Push delivery

- [x] Implement `src/runtime/completion-notify.ts`: completion notifier
  seam + host adapter sending only the hidden minimal S18 signal
  (`sendMessage` with `display: false`, details exactly
  `{ session_id, status }`, content naming the session/status with a
  `subagent_output` fetch instruction; no `ui.notify`). The shared Agent
  Output component serves the `subagent_output` tool result region only; no
  completion message renderer is registered and no foreground entry exists.
- [x] Fire once after terminal publication for every background record
  (natural + both shutdown paths); failures warn-only without record
  mutation; firing never blocks execution settlement.
- [x] Add tests: exactly-once hidden signal per natural background terminal
  status (completed/failed/stopped/aborted), queued and running
  shutdown-aborted settlement, and a natural-terminal/shutdown race; signal
  carries only session identity/status plus the fetch instruction and no
  child output/error/usage/model/thinking; full result remains readable via
  a later `subagent_output` poll; notifier rejection warn-only with
  unchanged record; no-host-surface degradation (polling still serves
  completion); hidden injected message with no toast, collapsed/expanded
  `subagent_output` Agent Output output/error/status rendering (including
  malformed/error envelopes), and preserved model-context projection.
- [x] Assert shutdown push cardinality by concrete queued and running session
  IDs, proving exactly one terminal push for each rather than only two total.

Satisfies: S17–S22, A4 (partial), A7, A8

Depends on: T2, T3

## T7. Input-boundary terminal visibility and invocation statistics

- [x] Replace the fixed terminal linger with per-record process-local
  visibility cleared only by later interactive/RPC parent input.
- [x] Preserve queued/running rows across boundaries, restore visibility on
  resume, isolate namespaces, and remove timeout state/constants.
- [x] Accumulate input/output tokens at assistant message settlement and publish
  coherent per-invocation counters at turn settlement without cache fields.
- [x] Render the count header and two-line tree with compact token values,
  singular/plural turns, and exact connector indentation.
- [x] Add deterministic runner/view/manager/boot tests for settlement timing,
  compaction, namespace/race/resume behavior, and source-filtered no-op input.
- [x] Refresh process-local confirmed stats before progress persistence settles;
  cover blocked and rejected writes, unchanged public output, and preservation
  during the next in-progress turn.
- [x] Roll back every resume-mutated process-local/UI field when queued
  persistence rejects; cover both previously visible and hidden terminal rows.

Satisfies: S11–S16, A5

Depends on: T4

## T6. Compatibility and full verification

- [x] Re-run the full 002 contract suites plus new suites; assert
  byte-compatibility of output/status projections and unchanged storage
  validators (new tests must not alter 003 fixtures).
- [x] Complete lint, typecheck, full tests, and build; record host-typing
  confirmations and any deviations in `verification.md`.

Satisfies: S23–S25, A1–A7 (all)

Depends on: T1–T5, T7

## T8. Parent operation abort cascade

- [x] Bind each host operation `AbortSignal` once at the `subagent_call` tool
  boundary and retain the binding after prompt background acceptance returns.
- [x] Abort every queued/running record in the matching parent namespace
  without closing that namespace; preserve unrelated namespaces and later
  independent calls.
- [x] Reuse existing queued/running abort settlement, slot release, terminal
  publication, Agents view refresh, and exactly-once completion notification.
- [x] Add focused tests for all-active cancellation, queued child suppression,
  namespace isolation, already-aborted signals, shared-signal deduplication,
  later-call admission, and natural-settlement/shutdown races.
- [x] Run lint, typecheck, full tests, and build; record results in
  `verification.md`.

Satisfies: R10, N7, C8, S27–S30, A9

Depends on: T2–T5
