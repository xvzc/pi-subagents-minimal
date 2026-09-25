# Design: Interruptible Subagent Wait

## Overview

Add a fifth public tool backed by a process-local namespace waiter in
`SessionManager`. The waiter is registered before current snapshots are
projected, terminal publication refreshes it, and the existing parent `input`
hook can resolve it without consuming the input. Re-wait is a fresh
snapshot-based operation; no event history is retained.

```text
src/
├── schemas.ts                    # SubagentWaitSchema and params
├── types.ts                      # wait service/result boundaries
├── index.ts                      # tool registration and input wiring
└── runtime/session-manager.ts    # waiter lifecycle and terminal refresh

test/
├── subagent-wait.test.ts         # focused behavior/race coverage
├── boot.test.ts                  # input registration/pass-through
└── tool-descriptions.test.ts     # fifth public tool contract
```

## Components

### Public schema and tool boundary

- `SubagentWaitSchema` contains only `session_ids`, an array with `minItems: 1`
  and `uniqueItems: true`; IDs are plain strings per existing schema policy.
- The tool binds the host operation signal before calling the wait service and
  returns the standard safe error envelope on failure.
- The top-level description states that the tool waits for all named sessions,
  normal parent input interrupts only the wait, and a later call rechecks
  current state.

### Namespace waiter

`SessionManager` owns at most one `ActiveWait` per namespace:

```ts
interface ActiveWait {
  namespace: string;
  sessionIds: readonly string[];
  settled: boolean;
  resolve(result: SubagentWaitResult): void;
  reject(error: unknown): void;
  dispose(): void;
}
```

`wait(params, context, signal)` performs synchronously, before its first yield:

1. derive the namespace;
2. reject an existing namespace waiter;
3. resolve and validate every requested record in that namespace;
4. create/register the waiter;
5. attach once-only operation-abort cleanup;
6. project current snapshots and immediately complete if none are active;
7. otherwise return the waiter promise.

Register-before-project plus terminal refresh prevents lost wakeups under the JS
run-to-completion model. `dispose()` is idempotent and removes the namespace map
entry plus signal listener.

### Terminal refresh

A small `refreshWaiter(namespace)` helper projects the waiter's records in
requested order. Every existing terminal publication path invokes it only after
the authoritative process-local snapshot becomes terminal. If no requested
record remains active, it completes the waiter. The helper does not alter
persistence, push delivery, cleanup, slot release, or view state.

### Input interruption

The existing `pi.on("input")` handler keeps its interactive/RPC source filter.
`SessionManager.onParentInput(context)` continues terminal-row visibility work
and additionally resolves an active waiter with the current projection and
reason `interrupted`. The hook returns no handled/transform result. Extension
input remains excluded at the index boundary.

### Abort and shutdown

- Tool execution uses the existing weak operation-signal binding so an operation
  abort still cascades to all active namespace records.
- The waiter also observes that signal only to settle/dispose its own promise;
  this listener never aborts children itself.
- `shutdown(context)` disposes/rejects the namespace waiter before or alongside
  its existing child drain barrier. All cleanup paths are idempotent.

## Decisions

### D1. All sessions only

The tool has no `mode`; its single meaning is a join barrier over all requested
sessions. Completion notifications and status inspection cover partial progress.

### D2. Snapshot-based re-wait

Terminal state is durable/process-local authoritative state. A fresh call reads
that state rather than replaying events, so no `wait_id`, cursor, inbox, or
completion-consumption semantics are required.

### D3. Input interrupts, abort cancels

Normal submitted input and operation abort are separate signals. Input resolves
only the wait and remains deliverable to the main agent. Abort follows the
existing child-cancellation policy.

### D4. No wait-specific UI

The standard tool call/result renderer is sufficient. This feature adds no TUI
widget or transcript placement behavior.

## Failure Handling

- Schema-invalid empty/duplicate arrays are rejected by the host boundary.
- Runtime malformed/missing/foreign IDs return `SESSION_NOT_FOUND` atomically.
- Same-namespace waiter collision returns `SESSION_BUSY` without replacing the
  first waiter.
- Input/terminal/abort/shutdown races pass through one settlement guard.
- Unknown internal failures use the existing redacted `INTERNAL_ERROR` envelope.

## Trade-offs

- Re-wait depends on the main agent choosing to call the tool again after
  handling input; automatic re-wait is intentionally out of scope.
- No partial completion wakeup is provided. Callers can inspect existing status
  or react to existing completion signals when partial progress matters.
