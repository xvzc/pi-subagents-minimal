# Verification: Background Concurrency, Queue, Agents TUI, and Push Delivery

Status: **IMPLEMENTED; FOCUSED VERIFICATION PASSED.** The current full suite
has two unrelated pre-existing expectation failures documented below.

## Traceability

```text
R1 → S1–S3 → config.ts/types.ts → config.test.ts → A6
R2, R3, R7 → S4–S10 → session-manager.ts → session-manager.test.ts → A1–A4
R4, R9 → S11–S16 → agent-runner.ts/session-manager.ts/agents-view.ts/index.ts
         → agent-runner.test.ts/agents-view.test.ts/session-manager.test.ts/boot.test.ts → A5
R5 → S17–S22 → completion-notify.ts/session-manager.ts/index.ts/agent-output.ts → completion-notify.test.ts → A7–A8
R6 → S23–S26 → contract/storage and Agent Output suites → A7
R10 → S27–S30 → index.ts/session-manager.ts → operation-abort.test.ts → A9
```

## Acceptance Evidence

| Criterion | Verification | Result |
|---|---|---|
| A1–A4 | Manager tests cover slot limits, FIFO admission, prompt queued acceptance with background settlement and push, persistence failures, and queued/running shutdown settlement. | PASS |
| A5 | Runner tests prove `message_end` accumulation, `turn_end` publication, in-progress stability, invocation reset, and cache exclusion. View tests prove the exact `› Agents · N working · N finished` header with both numeric counts using `dim`, two-line connectors, singular/plural turns, token compaction, markers, and timer disposal. Manager tests prove immediate process-local refresh while progress persistence is blocked or rejected, preservation of confirmed statistics during a later in-progress turn, unchanged public output until successful terminal publication, complete state rollback after rejected resume persistence for visible/hidden terminal rows, terminal persistence through time, boundary hiding, namespace isolation, and resume remount. Boot tests prove interactive/RPC filtering, extension exclusion, and no input mutation/handling. | PASS |
| A6 | Config tests cover default, bounds, invalid values/types, warnings, and precedence. | PASS |
| A7–A8 | Output/status/storage, completion, boot, and Agent Output tests prove unchanged projections, exactly-once hidden background signals, the `subagent_output` Agent Output renderer, no message/entry renderer registration, and full results readable via `subagent_output` after each signal. | PASS |
| A9 | `operation-abort.test.ts` covers same-namespace queued/running cancellation, queued child suppression, shared-signal association across namespaces, unrelated-namespace isolation, namespace reuse, already-aborted and repeated signals, exactly-once persistence/push, and blocked preparation/terminal/progress/creation/shutdown races. | PASS |

## Compatibility Evidence

- `StoredUsage`, storage schemas/version, tool schemas/results, status/output projections, and completion push construction were not changed.
- Widget counters are carried only by process-local `ChildExecutionObservation.widgetUsage` and `AgentViewRow`.
- Completion delivery preserves `triggerTurn`, `deliverAs`, and exactly-once behavior with the hidden minimal signal (`display: false`, details exactly `{ session_id, status }`, no toast, no registered renderer); the full result is fetched via `subagent_output` and rendered in its tool result region.
- Host expansion is global (`Ctrl+O`); with no custom message renderer registered, hidden background signals export generically and no synthetic tool result is emitted.
- Host input filtering uses the installed `InputEvent.source` union (`interactive | rpc | extension`) and the handler returns no transform/handled result.
- Assistant accounting uses the installed `AssistantMessage.usage.input` and `.output` fields; cache fields are deliberately ignored.
- The existing queue, shutdown, polling, retention, and push suites pass unchanged except tests intentionally updated from timed linger to input-boundary visibility.

## Commands

```text
npx vitest run test/boot.test.ts test/agent-output.test.ts test/completion-notify.test.ts test/subagent-call-rendering.test.ts
# PASS — 4 files, 36 tests.

npm run lint
# PASS — Biome checked 37 files.

npm run typecheck
# PASS — no diagnostics.

npm run test
# PASS — 17 files, 422 tests.
# Vitest emitted the pre-existing Vite native config-loader warning.

npm run build
# PASS — dist rebuilt with tsc -p tsconfig.build.json; no diagnostics.
```

## Operation-Abort Extension Verification (2026-09-25)

```text
npx vitest run test/operation-abort.test.ts test/session-manager.test.ts test/boot.test.ts test/contracts.test.ts
# PASS — 4 files, 126 tests.

npx prettier --check .specs/004-async-concurrency/{requirements.md,spec.md,design.md,tasks.md,verification.md} src/index.ts src/runtime/session-manager.ts test/operation-abort.test.ts
# PASS.

npm run lint
# PASS.

npm run typecheck
# PASS.

npm run build
# PASS.

npm run test
# PARTIAL — 23 files passed, 2 failed; 612 tests passed, 2 failed.
# Unrelated failures:
# - test/completion-notify.test.ts expects « but the existing renderer emits ❮.
# - test/tool-descriptions.test.ts expects stale shorter descriptions.
```

A fresh independent review approved S27–S30/A9 with no remaining findings.

## Limitations

- Real-provider token reporting remains provider-dependent; deterministic host-event tests verify the installed event contract and accounting boundaries.
- The extension cannot detect host-dropped widgets or follow-up messages; polling remains the recovery path.
