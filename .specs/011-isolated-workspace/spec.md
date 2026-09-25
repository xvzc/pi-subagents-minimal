# Specification: Isolated Workspace

Extends `002-subagent-runtime`. Contracts not amended below remain in force.

## Public Parameter

- **S1:** `subagent_call` parameters gain exactly one optional field:

  ```ts
  interface SubagentCallParams {
    workspaceDir?: string;
  }
  ```

  The field is a plain optional string at the TypeBox boundary; `null` and
  non-string values are rejected by the host schema boundary.
- **S2:** The `workspaceDir` schema description states that it names an
  isolated workspace for child execution only, that agent/config/skills/
  extensions/storage/namespace/cleanup remain rooted at the parent cwd, and
  that it is valid only for `type: "new"`.

## New-Session Semantics

- **S3:** Omission (`undefined`) preserves current behavior: the child is
  created with the parent `context.cwd`.
- **S4:** A supplied value is validated before ID allocation, persistence,
  extension preparation, or child creation. It must be a string that is
  non-blank after trimming, absolute, and an existing directory; any other
  value fails with `INVALID_ARGUMENT`.
- **S5:** Validation failures use one fixed message naming the requirement
  without the supplied path or filesystem details.
- **S6:** The resolved execution cwd is passed to child creation. Extension
  preparation continues to receive the parent `context.cwd`; session storage,
  namespace derivation, and cleanup contexts use the parent `context.cwd`.
- **S7:** No snapshot, output, status, or completion payload carries
  `workspaceDir`.

## Resume and Steer

- **S8:** `resume` rejects any supplied `workspaceDir` (`!== undefined`) with
  `INVALID_ARGUMENT` in its prohibited-field group, after prompt validation
  and alongside the existing agent check, before `session_id` presence and
  session lookup.
- **S9:** `steer` rejects any supplied `workspaceDir` (`!== undefined`) with
  `INVALID_ARGUMENT` in its existing prohibited-field group (agent, model,
  thinking), after prompt validation and before session lookup.
- **S10:** Resume reuses the retained live child with its original execution
  cwd; the workspace can never change across turns.

## Compatibility

- **S11:** No Git worktree is created or managed. No persisted schema,
  completion signal, Agents view, retention, or existing error code changes.

## Acceptance Criteria

- **A1:** Schema accepts omission and a string, rejects `null`, and documents
  isolated-workspace-only semantics with parent-root retention.
- **A2:** Omission creates the child with the parent cwd.
- **A3:** A valid workspace creates the child with that cwd while extension
  preparation, store creation, and cleanup observe the parent cwd; no
  snapshot, output, or status exposes the workspace.
- **A4:** Blank, relative, missing, and file paths fail with `INVALID_ARGUMENT`
  before allocation/persistence/preparation/creation, with no side effects
  and no path or filesystem details in the error.
- **A5:** `resume`/`steer` with any supplied value fail with `INVALID_ARGUMENT`
  even for unknown session IDs, with no mutation.
- **A6:** Full validation (format, lint, typecheck, tests, build) passes.
