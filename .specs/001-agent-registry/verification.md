# Verification: Agent Registry

T1–T5 are implemented and verified. The registry is activation-scoped and shared by list/new/resume until extension reactivation.

| Criterion | Planned verification | Result |
|---|---|---|
| A1 | Empty registry tool test | PASS (`test/subagent-list.test.ts`: an isolated activation with no files returns exactly `{ agents: [] }` with no `warnings` key or unbound error) |
| A2 | Valid metadata normalization table tests | PASS (`test/metadata.test.ts`: minimal/default normalization, exact S15 key set, name 1/64-char boundaries, description trim and 512-char limit, model trim, all seven thinking levels, tools omission vs `[]` with entry trimming, max_turns 1/10000 bounds, enabled default, body outer-trim with Markdown preserved, BOM/CRLF/delimiter-whitespace tolerance; `test/subagent-list.test.ts`: full optional-field summary maps to exactly `name/description/model/thinking/tools/max_turns/source`, `tools` omission stays omitted while `[]` stays `[]`, `maxTurns` maps to `max_turns`) |
| A3 | Unknown-key silent-ignore plus missing, invalid-known-field, and empty-body rejection tests | PASS (`test/metadata.test.ts`: unknown keys of any shape silently ignored with no warning; prototype-named keys treated as absent; missing/unclosed/invalid/non-mapping/empty frontmatter, missing required fields, every invalid known-field class, duplicate YAML keys, and missing/whitespace-only bodies each reject the whole file with exactly one path-specific warning, no partial definition, and redacted fixed reasons) |
| A4 | Global/shared-project/Pi-project precedence tests | PASS (`test/registry.test.ts`: exact paths, lexical direct lowercase-`.md` discovery, global/shared/Pi precedence, case-sensitive names, lexical same-directory replacement warning, invalid-higher preservation, invalid-file isolation, deterministic safe warning order, and filesystem failures; `test/subagent-list.test.ts`: enabled-only output sorted by case-sensitive code-unit name, `source` preserved per layer) |
| A5 | Disabled override test | PASS (`test/registry.test.ts`: a captured disabled higher-precedence definition remains authoritative, hides the lower definition from list/new lookup, and remains visible to retained-session metadata lookup for that activation; a fresh activation observes later removal; `test/subagent-list.test.ts`: disabled higher override hides the name from `subagent_list`) |
| A7 | Activation snapshot stability | PASS (`test/registry.test.ts`: one bound registry stays stable across add/edit/disable/remove operations, a newly constructed registry observes each change, and defensive-copy mutation cannot affect captured definitions/nested arrays/warnings; `test/subagent-list.test.ts`: repeated calls stay stable and a fresh extension activation refreshes results) |

Commands run:

```text
npm run lint       PASS
npm run typecheck  PASS (src and tests)
npx tsc -p tsconfig.build.json --noEmit  PASS
npm run test       PASS (6 files, 187 tests)
npm run build      PASS
```

T3/T5 notes: normal activation constructs one bound registry and shares it with the default `subagent_list` service and `SessionManager`; repeated calls use captured agents/warnings, while extension reactivation constructs a fresh snapshot. An explicitly injected `services.registry` is honored and never overwritten (`test/subagent-list.test.ts`: injected payload returned, filesystem files ignored; exact four tools unchanged; no prompt/path/raw leakage).

Independent review: PASS. No blocking correctness, specification, security, scope, or validation findings remain.

## Per-agent extension metadata (T4)

| Criterion | Verification | Result |
|---|---|---|
| A6 | `test/metadata.test.ts`, `test/subagent-list.test.ts`, and `test/subagent-list-rendering.test.ts` cover supported/malformed/duplicate sources, omission versus `[]`, configured-string list output, and consistent rendering | PASS |

Full validation after T4: `npm run lint`, `npm run typecheck`, `npm run test` (22 files, 512 tests), and `npm run build` all PASS.

## T5 Activation snapshot evidence

- Focused validation: `test/registry.test.ts`, `test/subagent-list.test.ts`, `test/session-manager.test.ts`, `test/invocation-resolver.test.ts`, and `test/tool-descriptions.test.ts` — PASS (5 files, 151 tests), including direct `SessionManager({ registryOptions })`, `session_start`, reactivation, and independent service-injection combinations.
- Full validation: `npm run lint`, `npm run typecheck`, `npm test` — PASS (22 files, 541 tests), and `npm run build` — PASS.
- Existing Vite native config-loader advisory was emitted and did not affect test success.
- Independent T5 review: **APPROVED** after direct composition and stale-spec follow-ups; no remaining findings.

## T6 Session-start warning notification

Status: **IMPLEMENTED, VALIDATED, AND INDEPENDENTLY APPROVED.**

| Criterion | Verification | Result |
|---|---|---|
| A8 | `test/boot.test.ts` covers one fixed aggregate warning notification per distinct `(cwd, parent session ID)` namespace, same-namespace deduplication, multi-warning count-only messaging, path/reason/content redaction, clean-snapshot silence, notification-failure isolation, and unchanged session restore. Existing `test/subagent-list.test.ts` coverage confirms activation snapshot stability and retained detailed diagnostics. | PASS |

Commands run:

```text
npx vitest run test/boot.test.ts test/subagent-list.test.ts
# PASS — 2 files, 27 tests.

npm run check
# PASS — lint, typecheck, 22 test files, 543 tests.

npm run build
# PASS — dist rebuilt with tsc -p tsconfig.build.json.
```

The existing Vite future native config-loader advisory was emitted during tests and did not affect success.

Independent review: **APPROVED.** The reviewer confirmed S23–S24/A8 behavior, namespace deduplication, fixed aggregate message safety, notification-failure isolation, hardened multi-warning/redaction coverage, and the documented retry-on-failure semantic. No blocking findings remain.
