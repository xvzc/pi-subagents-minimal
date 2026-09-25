# Requirements: Background Concurrency, Queue, Agents TUI, and Push Delivery

## Goal

Bound concurrent subagent execution with a configurable limit (default 8), hold
excess background work in a real FIFO queue, show a persistent Agents TUI
tree with per-invocation confirmed turn/token statistics and input-boundary
terminal visibility, and push terminal background output to the parent model without
polling, while keeping `subagent_output`/`subagent_status` polling available as
recovery and compatibility.

## Functional Requirements

- **R1:** Callers can configure the maximum concurrent subagent executions;
  the default limit is 8 (explicit user choice).
- **R2:** Beyond the limit, accepted `new` and `resume` executions wait in a
  real FIFO queue;queued records remain inspectable as `queued` until admitted.
- **R3:** Slots release deterministically on terminal settlement, shutdown
  settlement, and terminal-persistence failure paths so the queue always drains.
- **R4:** A persistent Agents TUI tree shows every visible queued, running, or
  terminal `new` and `resume` execution with a
  count header, status marker, role, short task label, elapsed duration, and a
  second-line invocation turn/input/output summary. Terminal rows remain until
  the next interactive or RPC parent input boundary; extension-sourced input
  does not hide them. A resumed record becomes visible again.
- **R5:** Terminal background completion (success or failure) is pushed to the
  parent model exactly once without requiring polling. The injected hidden
  follow-up message carries only the session identity, terminal status, and a
  concise instruction to call `subagent_output` for that session; it shows no
  transcript row and no user notice. The main agent fetches the authoritative
  full result via `subagent_output`, which renders it as a compact
  `Agent Output` row in its tool result region. Polling remains available as
  fallback (R6).
- **R6:** Polling APIs (`subagent_output`, session portions of
  `subagent_status`) remain fully available and unchanged as recovery and
  compatibility paths.
- **R7:** Every `new`/`resume` caller receives its queued acceptance promptly and observes completion via polling or push; there is no blocking synchronous execution.
- **R8:** Parent-namespace shutdown closes admission, settles queued-not-started
  records as `aborted` without creating children, and preserves the existing
  abort/drain/settle barrier for started records.
- **R9:** TUI rendering degrades gracefully when no TUI surface exists
  (non-TUI parent): execution, queueing, polling, and push behavior are
  unaffected.
- **R10:** Aborting a parent `subagent_call` operation aborts every queued or
  running background subagent in that parent namespace, including executions
  started by earlier calls; other parent namespaces remain unaffected.

## Non-Functional Requirements

- **N1:** At most one turn runs per session (inherited from 002 N1); the
  concurrency limit bounds simultaneous executions, never turns within a
  session.
- **N2:** Queue admission decisions are linearizable: slot release and next
  admission occur in the same synchronous pump with no intervening yield.
- **N3:** Push delivery never mutates session records and never throws into
  the parent session; delivery failure is warn-only with a fixed redacted
  diagnostic.
- **N4:** The TUI layer uses only public Pi 0.84.2 host APIs
  (`ctx.ui.setWidget`, its supplied `Theme`, and
  `requestRender`) and introduces no new production dependencies and no host
  modifications.
- **N5:** Completion requires lint, type checking, tests, and build checks to
  pass (constitution Testing).
- **N6:** Every externally observable behavior and error contract has automated
  coverage; queueing, shutdown, and push paths require focused tests.
- **N7:** Operation-abort handling is idempotent and race-safe with natural
  settlement and namespace shutdown. Repeated `subagent_call` executions under
  the same host operation signal do not accumulate duplicate listeners.

## Constraints

- **C1:** Configuration follows the existing layered pattern (000 S8–S16):
  built-in defaults, valid global fields, valid project fields, merged
  field-by-field; invalid values warn and keep the lower-precedence value;
  unknown fields warn and are ignored; the effective object is frozen and
  loaded once per activation.
- **C2:** `onUpdate` is invalid after `execute` returns and must not be used
  for completion delivery.
- **C3:** Custom widgets can render above/below the editor and call
  `requestRender`; there is no dedicated host tree component, so the tree is
  rendered as text content inside a custom widget.
- **C4:** Widget token accounting may use installed public child-session
  `message_end` and `turn_end` events, but must remain process-local and must
  not change persisted usage or public projections.
- **C5:** Output-size handling is unchanged from existing behavior: full
  observed last-assistant text persists and is returned by polling; push
  embeds that same projection without introducing truncation.
- **C6:** No new public error codes; closed-namespace admission keeps the
  existing `INTERNAL_ERROR` "The parent session is shutting down." contract
  (002 C10), and shutdown settlement keeps `PARENT_SHUTDOWN` (002 C11).
- **C7:** No storage migration: queue state is process-local; persisted
  snapshots keep the 003 schema unchanged.
- **C8:** Operation abort reuses the existing terminal `aborted` settlement and
  `PARENT_SHUTDOWN` error contract; it adds no public tool, parameter, error
  code, or persisted field.

## Non-Goals

- Session cancellation tool (still a 002 non-goal).
- Resume across process restart (still a 002 non-goal).
- Output truncation or summarization for large results.
- Per-agent or per-namespace limit partitioning; one process-wide limit.
- Rich interactive widgets (click/expand/collapse); the tree is read-only text.
- Retrying failed executions or re-queueing terminal records.

## Assumptions

- Agent resolution (001), session lifecycle/persistence/retention (002/003),
  and host APIs (`ctx.ui.setWidget`,
  `pi.sendMessage({ customType, content, display, details },
  { triggerTurn: true, deliverAs: "followUp" })`) behave as stated in the
  brief; host API shapes are verified against the installed
  `@earendil-works/pi-coding-agent` 0.84.2 typings during implementation
  (see verification.md for the confirmed shape). `convertToLlm` includes
  `custom`-role content in LLM context regardless of `display`; setting
  `display: false` keeps the completion signal hidden from the transcript
  without changing model delivery.
- The extension host delivers one `session_shutdown` per namespace as today.

## Unresolved Questions

None. Open implementation details (widget refresh interval, label length) are
fixed in spec/design within the bounds above.
