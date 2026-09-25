# Requirements: Isolated Workspace

## Goal

Let a new subagent session execute in an caller-chosen isolated workspace
directory without changing where parent-owned resources live, so parallel or
sensitive work can run outside the parent working directory.

## Functional Requirements

- **R1:** `subagent_call` accepts an optional camelCase `workspaceDir` field
  that is valid only for `type: "new"`.
- **R2:** Omitting `workspaceDir` preserves current behavior: the child
  executes with the parent `context.cwd`.
- **R3:** A supplied value must be a non-blank absolute path to an existing
  directory; anything else fails with coded `INVALID_ARGUMENT`.
- **R4:** `resume` and `steer` reject any supplied `workspaceDir` with coded
  `INVALID_ARGUMENT` before session lookup or mutation.
- **R5:** Only child execution uses the workspace. Agent, config, skills,
  extensions, context, session storage, namespace, and cleanup remain rooted
  at the parent `context.cwd`.
- **R6:** `workspaceDir` is never persisted in snapshots nor exposed in
  output, status, or completion results.

## Non-Functional Requirements

- **N1:** Invalid values are rejected before ID allocation, persistence,
  extension preparation, or child creation, with no side effects.
- **N2:** Error envelopes never expose the supplied path or filesystem
  exception details.
- **N3:** Resume reuses the retained live child and cannot change its cwd.
- **N4:** Public behavior has focused automated tests; completion requires
  format, lint, typecheck, full tests, and build checks.

## Constraints

- **C1:** TypeBox continues to reject `null`; the runtime handles the typed
  `string | undefined` contract.
- **C2:** No Git worktrees are created or managed.
- **C3:** Tool/schema descriptions state that the workspace is execution-only
  and does not change resource roots.

## Non-Goals

- Changing the parent cwd or per-session resource roots.
- Persisting, returning, or listing the workspace directory.
- Worktree management, directory creation, or path normalization beyond the
  stated validation.
- Foreground execution or new waiting/polling semantics.

## Assumptions

- The Pi child-session factory already binds built-in tools, child session
  cwd, and extension runtime execution to the cwd passed at creation.
- Callers that pass a workspace ensure it is genuinely isolated when they
  need parallel writers.

## Unresolved Questions

None.
