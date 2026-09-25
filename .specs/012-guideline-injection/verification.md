# Verification: Configurable Coordination Guideline Injection

## Acceptance Results

| Criterion | Result | Evidence |
|---|---|---|
| A1 default-enabled append | PASS | `test/guideline-injection.test.ts` activation and registered-handler cases |
| A2 disabled registration | PASS | project config `injectGuidelines: false` yields no `before_agent_start` handler while lifecycle handlers remain |
| A3 exact-block deduplication | PASS | pure helper and registered-handler idempotence cases |
| A4 separator behavior | PASS | empty prompt equals the block; non-empty prompt equals existing text + `\n\n` + block |
| A5 config contract | PASS | `test/config.test.ts` covers boolean values, precedence, invalid fallback, and warning redaction |
| A6 parent-only scope | PASS | handler returns only `systemPrompt`; `SessionManager` child prompt construction is unchanged; independent review approved |

## Validation Evidence

- `npm run lint` — PASS.
- `npm run typecheck` — PASS.
- `npx vitest run test/config.test.ts test/guideline-injection.test.ts test/tool-descriptions.test.ts` — PASS, 3 files and 81 tests.
- `npm run build` — PASS; generated `dist/guidelines.js` and declarations are present.
- Direct post-build comparison of `dist/guidelines.js` export with the newline-normalized `/Users/kazusa/.config/pi/agent/SYSTEM.md` `<agent-coordination>...</agent-coordination>` section — PASS, exact equality at 5,795 characters.
- Independent read-only review — APPROVED with no actionable findings.

## Full-Suite Exception

`npm test` ran 31 files and 692 tests: 30 files / 691 tests passed, with one unrelated pre-existing failure in `test/workspace-dir.test.ts`. The test expects `Valid only for type "new"`, while the untouched schema description contains `Only valid for type: "new"`. This mismatch predates and is independent of guideline injection; it was not changed because it is outside this feature's authorized write scope.

## Remaining Risk

The embedded guideline is intentionally a source snapshot. Future edits to the global `SYSTEM.md` coordination block require an explicit source refresh and exactness re-check; runtime file loading is a non-goal.
