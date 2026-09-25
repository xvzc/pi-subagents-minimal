# Specification: Interruptible Subagent Wait

Extends `002-subagent-runtime` and `004-async-concurrency`. Contracts not
amended below remain in force.

## Public Tool

- **S1:** Register `subagent_wait` with parameters exactly:

  ```ts
  interface SubagentWaitParams {
    session_ids: string[];
  }
  ```

  `session_ids` has at least one item and unique items; unknown properties are
  rejected. IDs remain unconstrained strings at the TypeBox boundary.
- **S2:** Runtime validation resolves every ID in the caller's parent namespace.
  A malformed, missing, or foreign ID returns the existing `SESSION_NOT_FOUND`
  envelope. Validation is all-or-nothing and starts no wait on failure.
- **S3:** At most one wait is active in a parent namespace. A concurrent second
  wait returns `SESSION_BUSY`. Different namespaces may wait independently.

## Wait Semantics

- **S4:** `subagent_wait` returns normally only when all requested sessions are
  terminal or when qualifying parent input interrupts it. It uses no polling or
  timeout.
- **S5:** Terminal statuses are `completed`, `failed`, `stopped`, and `aborted`;
  active statuses are `queued` and `running`.
- **S6:** Wait startup first makes the waiter observable to terminal publication
  and then inspects authoritative current snapshots. A settlement concurrent
  with startup cannot be missed. If all sessions are already terminal, the tool
  returns immediately.
- **S7:** Terminal publication re-evaluates affected active waiters. A waiter
  resolves `completed` exactly once when its final pending session becomes
  terminal, then removes all listener/registry state.
- **S8:** Re-invocation creates a fresh wait from current snapshots. Sessions
  that completed while no wait was active are recognized immediately; only
  remaining active sessions keep the new call pending. No event replay,
  completion consumption, or public wait identity exists.

## Input Interruption

- **S9:** Submitted parent input with source `interactive` or `rpc` resolves the
  active namespace wait exactly once with reason `interrupted`. It does not
  abort, steer, resume, or otherwise mutate requested subagent sessions.
- **S10:** The input hook neither handles nor transforms the input, so normal
  host delivery to the main agent is preserved. Source `extension` does not
  interrupt a wait.
- **S11:** The result is a snapshot projection at settlement time:

  ```ts
  interface SubagentWaitResult {
    reason: "completed" | "interrupted";
    terminal: Array<{
      session_id: string;
      status: "completed" | "failed" | "stopped" | "aborted";
    }>;
    pending: Array<{
      session_id: string;
      status: "queued" | "running";
    }>;
  }
  ```

  Both arrays preserve requested `session_ids` order. For reason `completed`,
  `pending` is empty. The result includes no output, error, usage, model,
  thinking, timestamps, metadata, or warnings.

## Abort, Shutdown, and Compatibility

- **S12:** The host operation signal is bound before wait mutation. An
  already-aborted signal performs no wait mutation and follows the existing
  operation-abort error behavior. Later abort removes the waiter and retains
  the 004 namespace-wide child-abort behavior.
- **S13:** Namespace shutdown removes its active waiter and cannot leave a
  pending wait promise or listener. Completion/input/abort/shutdown races have
  one winner and no duplicate resolution.
- **S14:** Existing terminal persistence and completion push remain exactly
  once and are not consumed or suppressed by waiting. `subagent_output`,
  `subagent_status`, `subagent_call`, storage schemas, queueing, concurrency,
  retention, and Agents view contracts are unchanged.
- **S15:** No TUI widget, message renderer, custom entry, timer, production
  dependency, persisted field, timeout, mode parameter, or automatic re-wait is
  introduced.

## Acceptance Criteria

- **A1:** Waiting on mixed queued/running sessions remains pending until all are
  terminal, then returns `completed` with ordered terminal projections and no
  pending entries.
- **A2:** Waiting on already-terminal sessions returns immediately without
  installing residual waiter state.
- **A3:** Interactive and RPC input return `interrupted` with ordered current
  terminal/pending projections, leave every child running, and remain unhandled
  for normal parent delivery; extension input is a no-op.
- **A4:** A later call with the same IDs immediately observes sessions completed
  during the interruption gap and waits only for any remaining active sessions.
- **A5:** A settlement racing startup is not lost; completion, input, operation
  abort, and shutdown races resolve/clean the waiter exactly once.
- **A6:** Missing, malformed, and foreign IDs fail atomically with
  `SESSION_NOT_FOUND`; concurrent same-namespace waits fail with `SESSION_BUSY`;
  different namespaces remain independent.
- **A7:** Operation abort still aborts all active background sessions in the
  namespace, while plain input interruption never calls child abort.
- **A8:** Existing completion push cardinality, polling projections, storage
  records, and tool contracts remain unchanged; full validation and independent
  review pass apart from explicitly documented unrelated baseline failures.
