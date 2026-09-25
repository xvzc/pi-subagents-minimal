# Requirements: Interruptible Subagent Wait

## Goal

Allow the main agent to wait without polling until a selected set of background
subagent sessions all become terminal, while letting ordinary parent input
interrupt only the wait so the same main agent can handle the input and later
wait again against authoritative current state.

## Functional Requirements

- **R1:** Expose one public `subagent_wait` tool accepting only a non-empty,
  duplicate-free `session_ids` array.
- **R2:** A wait completes only when every requested session is terminal
  (`completed`, `failed`, `stopped`, or `aborted`).
- **R3:** Interactive or RPC parent input interrupts the active wait without
  cancelling any subagent and remains available to the host/main agent.
- **R4:** Re-invoking the tool rechecks current authoritative snapshots and
  waits only for sessions that remain `queued` or `running`; it does not depend
  on retained completion events or a public wait identifier.
- **R5:** Parent operation abort keeps the existing 004 contract: it terminates
  queued/running background subagents in the affected namespace and cleans up
  the wait.
- **R6:** The result reports why the wait returned plus terminal and pending
  projections in the caller's requested order. Full output remains available
  only through `subagent_output`.

## Non-Functional Requirements

- **N1:** Registration and initial state inspection prevent lost wakeups when a
  session settles concurrently with wait startup.
- **N2:** Completion, input interruption, operation abort, and namespace
  shutdown races settle and dispose each wait at most once.
- **N3:** Wait state is process-local and introduces no persisted fields,
  production dependencies, timers, or polling loops.
- **N4:** Existing tool result shapes, completion notifications, storage,
  concurrency limits, and Agents view behavior remain unchanged.
- **N5:** Public behavior and asynchronous races have focused automated tests;
  completion requires format, lint, typecheck, full tests, and build checks.

## Constraints

- **C1:** Session IDs remain plain strings at the schema boundary; runtime
  ownership/state validation returns existing coded error envelopes.
- **C2:** Every requested session must exist in the caller's parent namespace.
  A missing, malformed, or foreign ID returns `SESSION_NOT_FOUND` without
  exposing another namespace.
- **C3:** Only one wait may be active per parent namespace. A concurrent second
  wait returns existing `SESSION_BUSY`.
- **C4:** The existing `input` extension hook is extended; it must not transform
  or handle the input. Extension-sourced input does not interrupt a wait.
- **C5:** The tool receives and observes the host operation `AbortSignal` and
  uses the existing namespace-wide operation-abort binding.

## Non-Goals

- `any` mode or other completion modes.
- Timeout support.
- Sticky or automatic re-wait after parent idle.
- Public `wait_id`, completion inbox, or event replay.
- TUI widget or transcript reordering.
- Direct slash-command steering.
- Main-agent forking or background execution.
- Changes to completion notification delivery.

## Assumptions

- The host emits `input` for submitted interactive and RPC prompt input while a
  tool promise is pending, and leaving the event unhandled preserves normal
  parent delivery.
- Existing session snapshots and terminal publication are authoritative.

## Unresolved Questions

None.
