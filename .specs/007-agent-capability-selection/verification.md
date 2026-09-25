# Verification: Agent Capability Selection

## Acceptance Criteria

| Criterion | Verification | Result |
|---|---|---|
| A1 | `test/wildcard-tools.test.ts`, `test/metadata.test.ts` cover normalized defaults, `[]`, `true`, trimmed lists, duplicates, blank/non-string entries, `false`, `null`, quoted `*`, bare YAML `*`, and exact field warnings | PASS |
| A2 | Registry, list, and rendering tests cover normalized policies, defensive copies, and all/none/named rendering | PASS |
| A3 | Runtime capability tests cover default-none, all, exact named sets, deny subtraction, and deny-only non-granting behavior | PASS |
| A4 | Runtime and extension-loading tests cover post-load built-in, ambient, project, selected-extension catalogs, unknown allow/deny rejection before allocation, and disposal | PASS |
| A5 | Real Pi session integration verifies filtered skills in the generated system prompt and `/skill:name` lookup | PASS |
| A6 | Session-manager resume coverage verifies retained capability configuration is not reloaded | PASS |
| A7 | Formatting, lint, type checking, 597 tests across 24 files, and build | PASS |

## Commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

All commands passed on 2026-09-24. Vitest emitted only its existing advisory about future native Vite config loading.

## Unverified

None.
