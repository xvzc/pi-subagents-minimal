# Verification: Isolated Workspace

Status: **IMPLEMENTED; FULL VERIFICATION PASSED.**

## Traceability

```text
R1 → S1–S2 → schemas.ts → workspace-dir.test.ts (schema contract) → A1
R2, R5, R6 → S3, S6–S7 → session-manager.ts → workspace-dir.test.ts (execution) → A2–A3
R3 → S4–S5 → session-manager.ts → workspace-dir.test.ts (invalid values) → A4
R4 → S8–S10 → session-manager.ts → workspace-dir.test.ts (rejection) → A5
N4 → S11 → full validation below → A6
```

## Acceptance Evidence

| Criterion | Verification | Result |
|---|---|---|
| A1 | Schema checks accept omission and strings, reject `null`/numbers, and assert the isolated-workspace-only description with parent-root retention. | PASS |
| A2 | Omission test proves child creation receives the parent cwd. | PASS |
| A3 | Valid-workspace test proves child creation receives the workspace while extension preparation, store creation, and cleanup observe the parent cwd; snapshots, output, and status carry no `workspaceDir`. | PASS |
| A4 | Blank, relative, missing, and file paths fail with the fixed `INVALID_ARGUMENT` message, no allocation/preparation/creation/write, no path or `ENOENT` leakage, and empty status. | PASS |
| A5 | Resume/steer with a workspace fail with `INVALID_ARGUMENT` even for unknown IDs, with unchanged writes, no prompt/steer calls, and preserved terminal state. | PASS |
| A6 | Format check, lint, typecheck, full tests, and build pass with no failures. | PASS |

## Commands

```text
npm run format:check
# PASS — all matched files use Prettier style.

npm run lint
# PASS.

npm run typecheck
# PASS.

npx vitest run test/workspace-dir.test.ts
# PASS — 1 file, 10 tests.

npm run test
# PASS — 30 files, 667 tests.

npm run build
# PASS.
```

## Review

Self-checked the diff for scope: schema field plus description, one
validation helper with fixed redacted errors, execution-cwd routing to child
creation only, resume/steer prohibited-field checks, focused tests, and the
011 spec set with README registration. No unrelated files touched.

## Limitations

- The parent cwd is not existence-checked on omission; that path is unchanged
  existing behavior.
- Resume cannot adopt a workspace; callers start a new session instead.
- No worktree management, directory creation, or workspace persistence exists
  by design.
