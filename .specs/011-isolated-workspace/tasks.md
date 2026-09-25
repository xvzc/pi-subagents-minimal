# Tasks: Isolated Workspace

Scope: one optional `subagent_call` field for child execution cwd only. No
resource-root, storage, completion, view, retention, or worktree changes.

## T1. Public parameter contract

- [x] Add optional `workspaceDir` to `SubagentCallSchema` with an
  isolated-workspace-only description covering parent-root retention and
  new-only validity.
- [x] Keep TypeBox rejection of `null`/non-string values.

Satisfies: R1, C1, C3, S1–S2, A1

## T2. New-session validation and child routing

- [x] Validate a supplied value (non-blank string, absolute, existing
  directory) after model resolution and before ID allocation with one fixed
  redacted message.
- [x] Route the resolved execution cwd only to child creation; keep
  `prepareExtensions`, store, namespace, and cleanup on the parent cwd.
- [x] Never persist or expose the workspace in snapshots, output, or status.

Satisfies: R2–R3, R5–R6, N1–N2, C2, S3–S7, A2–A4

Depends on: T1

## T3. Resume and steer rejection

- [x] Reject any supplied `workspaceDir` on `resume`/`steer` with
  `INVALID_ARGUMENT` in their existing prohibited-field groups before
  session lookup or mutation.
- [x] Keep resume on the retained live child with its original cwd.

Satisfies: R4, N3, S8–S10, A5

Depends on: T1

## T4. Compatibility and verification

- [x] Add `test/workspace-dir.test.ts` covering schema/descriptions, omission
  fallback, valid-workspace routing with parent roots, invalid values with no
  side effects, and resume/steer rejection with no mutation.
- [x] Run format check, lint, typecheck, focused tests, full tests, and
  build; record exact results in `verification.md`.

Satisfies: N4, S11, A6

Depends on: T1–T3
