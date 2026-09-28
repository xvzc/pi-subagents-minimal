# Verification: Subagent Runtime

T1–T10 are implemented and verified. T10 independent review: **APPROVED**, with no remaining findings.

| Criterion | Verification | Result |
|---|---|---|
| A1 | `test/session-manager.test.ts` background named-agent lifecycle (queued acceptance plus output/poll completion) and `test/agent-runner.test.ts` public Pi SDK composition | PASS |
| A2 | `test/session-manager.test.ts` background queued acceptance/progress/completion for new and resume, including immutable acceptance and owned settlement | PASS |
| A3 | `test/invocation-resolver.test.ts`, `test/registry.test.ts`, `test/agent-runner.test.ts`, and `test/session-manager.test.ts` cover shared activation/current-call resolution, resume snapshot lookup after visibility checks, captured disabled/missing definitions, changed/unchanged reconfiguration, persisted effective settings, child/extensions/tools reuse, validation/failure atomicity, shutdown-before-configuration, reservation, namespace hiding, and data-only reload rejection | PASS |
| A4 | `test/session-manager.test.ts` running/terminal/unknown steer matrix, queue-insertion versus settlement race, exact acknowledgement, and redacted Pi failure; `test/agent-runner.test.ts` public steer delegation | PASS |
| A5 | Repeat output, loaded/local inspection, summary-only status, deterministic ordering, cleanup eviction, aggregate redacted cleanup-result diagnostics, and closed-namespace readability in `test/session-manager.test.ts`; awaited activation load plus fixed activation cleanup result/error diagnostics in `test/boot.test.ts` | PASS |
| A6 | Shared resolver and manager tests prove independent activation-snapshot agent → call → config → current-parent precedence for new and resume, including agent dominance over supplied blank/call values | PASS |
| A7 | Resolver tests prove strict unsupported agent/call/config thinking, parent-only clamping, and `INVALID_ARGUMENT` when every thinking layer is absent | PASS |
| A8 | `test/session-manager.test.ts` namespace shutdown barrier/races/failures including abort rejection with a non-settling prompt and handled late rejection, `test/agent-runner.test.ts` public abort delegation, `test/boot.test.ts` all-reason awaited lifecycle wiring, and `test/storage-record-store.test.ts` restart normalization | PASS |
| A9 | `test/agent-runner.test.ts` exact assistant-stop versus prompt-throw shapes, unchanged success paths, fixed diagnostic shape with bounded cause-label inspection, provider-text exclusion from diagnostics, and malformed-Unicode classification; `test/failure-cause.test.ts` and `test/session-manager.test.ts` cover safe labels and fallbacks | PASS |

## T5 Focused Evidence

- The shutdown handler is registered once and awaits `sessions.shutdown(context)` for `quit`, `reload`, `new`, `resume`, and `fork`.
- Namespace tests prove synchronous admission closure, stable `INTERNAL_ERROR` messaging, same-promise memoization, output readability, and independence of a different parent namespace.
- Race tests cover pending initial queued persistence, child creation after marking, resume reservation during its queued write, an in-flight natural terminal commit, and a blocked progress refresh. Shutdown wins whenever marked before terminal commit; already committed terminal snapshots are untouched.
- Running-child tests prove abort-before-aborted-write ordering, fixed `PARENT_SHUTDOWN` storage error, and preservation of observed output/usage. Public runner coverage proves `ChildSessionHandle.abort()` awaits `AgentSession.abort()`.
- Failure tests prove fixed redacted abort/persistence diagnostics, forced `PARENT_SHUTDOWN` settlement when abort rejects while the prompt remains pending, no unhandled rejection or late overwrite when that detached prompt later rejects, process-local aborted publication after persistence failure, cleanup skipping for that record, all-settled continuation to another record, and warn-only cleanup failure after successful persistence.
- Cleanup diagnostics tests prove one exact aggregate warning for non-empty returned warning lists and one exact activation failure warning, with injected path/message/exception secrets absent from logs.
- Existing namespace-hiding assertions remain green. The shutdown selector covers all active child records and writes only session snapshots.
- `RecordStore` restart-normalization tests prove loaded data-only active session records persist as terminal aborted before exposure and require no live abort.

## Commands

```text
npx vitest run test/invocation-resolver.test.ts test/session-manager.test.ts test/boot.test.ts test/storage-retention.test.ts
PASS — 4 files, 105 tests

npm run lint
PASS — Biome checked 30 files

npm run typecheck
PASS — tsc --noEmit

npm test
PASS — 13 files, 327 tests

npm run build
PASS — tsc -p tsconfig.build.json
```

Vitest emitted the repository's existing Vite `configLoader: 'native'` future-compatibility warning; all tests passed.

Independent final review: **APPROVED**. No critical or major findings remain after two bounded rework rounds. The sole minor documentation finding (the component tree named a nonexistent `session-snapshots.ts`) was corrected to `status-service.ts`.

## T6 Evidence (original implementation)

- Installed Pi 0.84.2 types expose assistant `stopReason`, optional `rawStopReason`, and optional `errorMessage` on `turn_end`; prompt rejection exposes its thrown value. The original implementation read only normalized `stopReason` and did not inspect provider text or thrown values; later cause-label behavior is described below.
- Original regressions proved provider-controlled raw/error text and malformed Unicode prompts/output could not alter phase/turn/stop diagnostics.
- Focused tests: `npx vitest run test/agent-runner.test.ts test/storage-schemas.test.ts` — PASS (2 files, 24 tests).
- Full checks: `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` — PASS (20 test files, 474 tests).

## Safe cause-label update

- The current implementation inspects bounded assistant-stop error text and prompt-rejection causes only to choose fixed, non-provider-controlled error-message labels. The phase/turn/stop diagnostic stays unchanged. Unrecognized or inaccessible text falls back to the original generic message; creation, reconfiguration, and storage errors remain generic.
- Tests in `test/failure-cause.test.ts`, `test/agent-runner.test.ts`, and `test/session-manager.test.ts` cover categorization, secret exclusion, throwing accessors, ambiguous bare status codes, local-failure fallback, and retained output. Real-provider cause formats are not exhaustively verified; heuristic labels can misidentify ambiguous messages.

## Limitations

- Real-provider authentication/network execution was not run because it is environment-dependent. Deterministic fake-child tests exercise shutdown lifecycle, races, and failures through the same manager boundary.
- JavaScript cannot forcibly settle an arbitrary raw host prompt or storage/cleanup promise. After abort rejection, the manager settles its own wrapper and keeps handlers attached to the detached prompt; a host promise that remains pending can remain allocated until the host releases it. No arbitrary timeout was added. Successful abort still relies on the host contract that orderly abort eventually settles the prompt.
- New and resume share the same pure resolver and activation registry; resume looks up only captured normalized model/thinking metadata after session visibility/resumability checks.

## T7 Per-agent extension evidence

| Criterion | Verification | Result |
|---|---|---|
| A10 | `test/extension-sources.test.ts` covers unversioned npm syntax, rejection of exact/range/tag suffixes, Pi-managed project-before-user precedence, scoped packages, missing-package failure, exclusion of ordinary `node_modules`, absence of temporary resolution, npm/path containment without invalid-candidate fallback, Pi 0.84.2 manifest glob/exclusion ordering and deduplication, convention-directory discovery, ignore files, and invalid targets | PASS |
| A10 | `test/extension-loading.test.ts` uses only local fixtures to prove Pi 0.84.2 loads explicit canonical entrypoints with `noExtensions: true`, excludes ambient tools and unrelated package-root scripts, honors manifest glob exclusions, prevents escaped/excluded factory side effects before import, rejects load errors/conflicts, and exposes the exact omitted/empty/explicit active names through real Pi sessions with an injected in-memory credential store | PASS |
| A10 | `test/agent-runner.test.ts` fakes Pi resource loading to prove an installed npm package is converted to a canonical entrypoint before loader handoff, with ambient loading disabled and prepared-loader/tool forwarding preserved | PASS |
| A10 | `test/session-manager.test.ts` proves pre-allocation extension loading, loaded extension tool allowlisting, stable redacted parent-boundary errors, pending-preparation shutdown synchronization, exactly-once disposal across validation/setup/creation/canceled-admission/persistence races, unchanged snapshots, retained-child resume reuse, and normal shutdown transfer/disposal | PASS |

Historical T7 validation (before T8): no credentials, package installation, registry access, or network access were used. Real-session tests injected `InMemoryCredentialStore`. Focused extension/runtime tests (4 files, 148 tests), `npm run lint`, `npm run typecheck`, `npm run test` (22 files, 547 tests), and `npm run build` all passed at that milestone.

## T8 Resume override evidence (historical baseline, superseded by T9 precedence)

- `resolveResumeModelThinking` preserves the retained effective pair when omitted, resolves canonical or unique bare model overrides, validates thinking-only/model-only/combined effective pairs without clamping, and returns `MODEL_NOT_FOUND` when a thinking-only override cannot find the retained model in the current catalog.
- `ChildSessionHandle.configure` delegates to public Pi `setModel` before `setThinkingLevel`; model failure prevents thinking application.
- Session-manager tests prove effective settings appear in queued and terminal projections, remain retained by a later override-free resume, and configure only after queued persistence/admission and before running persistence/prompt.
- Invalid overrides cause no write/configuration; queued-write and pre-admission shutdown paths do not configure; post-acceptance configuration failure disposes/removes the uncertain child, writes a failed terminal snapshot without prompting, and makes later resume return `SESSION_NOT_RESUMABLE`. Steer continues rejecting model and thinking overrides before lookup.
- Tool-schema descriptions document new/resume override support and steer prohibition.

```text
npm run lint
PASS — 45 files checked

npm run typecheck
PASS — no diagnostics

npx vitest run test/invocation-resolver.test.ts test/agent-runner.test.ts test/session-manager.test.ts test/tool-descriptions.test.ts
PASS — 4 files, 134 tests

npm test
PASS — 22 files, 552 tests

npm run build
PASS — tsc -p tsconfig.build.json
```

Vitest emitted the existing Vite native config-loader advisory; it did not affect test success.

## T9 Agent-first shared precedence evidence

- `resolveInvocationModelThinking` is shared by new and resume and independently resolves model/thinking from activation-snapshot agent frontmatter, call parameters, effective config, and current parent context.
- Resolver tests cover all four layers, agent dominance over call values, authoritative call-level blank models when agent metadata is absent, exact model identity, strict agent/call/config thinking, parent-only clamping, and missing model/thinking failures with no retained or built-in fallback.
- Registry tests prove retained lookup uses the same captured snapshot as enabled new-session selection, may include captured disabled definitions, remains stable across file edits, and refreshes on reconstruction.
- Session-manager tests prove resume snapshot lookup happens only after visibility/resumability checks, captured agent metadata outranks call parameters, missing metadata falls through, changed values configure after queued persistence/admission, unchanged values skip configuration, and existing child/extensions/tools are reused.
- Tool-schema tests assert the public agent → call → config → current-parent guidance and unchanged steer prohibition.

```text
npm run lint
PASS — 45 files checked

npm run typecheck
PASS — no diagnostics

npx vitest run test/invocation-resolver.test.ts test/registry.test.ts test/session-manager.test.ts test/tool-descriptions.test.ts test/agent-runner.test.ts
PASS — 5 files, 144 tests

npm test
PASS — 22 files, 537 tests

npm run build
PASS — tsc -p tsconfig.build.json
```

Vitest emitted the existing Vite native config-loader advisory; it did not affect test success.

## T10 Activation-scoped registry consumption evidence

- `createAgentRegistry` eagerly captures one normalized snapshot and returns defensive copies for list/new/resume consumers.
- `src/index.ts` composes one bound registry into both the default list service and default `SessionManager`; `session_start` remains limited to persisted-session loading.
- Registry/list tests prove stability across file edits within an activation and refresh after registry/extension reconstruction. Session-manager tests continue to prove visibility checks precede retained-agent metadata lookup and that only model/thinking affect the retained child.
- Focused validation: registry, list, session-manager, resolver, and tool-description tests — PASS (5 files, 151 tests), including direct `SessionManager({ registryOptions })`, `session_start`, reactivation, and independent service-injection combinations.
- Full validation: lint and typecheck PASS; `npm test` PASS (22 files, 541 tests); build PASS.
