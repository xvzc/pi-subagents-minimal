# Tasks: Subagent Runtime

## T1. Invocation resolution

- [x] Implement model/thinking precedence and model lookup.
- [x] Query supported levels for the resolved model.
- [x] Reject explicit unsupported thinking and clamp parent inheritance.
- [x] Add complete precedence matrix tests.

Satisfies: S15–S20, A6–A7

Depends on: `000-foundation/T2`, `001-agent-registry/T2`

## T2. Background new sessions

- [x] Implement child creation and `ses_` records.
- [x] Apply normalized prompt/tools/turn limits.
- [x] Implement background `new` and warning behavior.
- [x] Capture effective model/thinking, output, errors, and usage.
- [x] Add fake-model integration tests.

Satisfies: S1–S6, S22, S24–S27, A1

Depends on: T1, `003-record-storage/T2`

## T3. Background output and status

- [x] Implement background new execution and event-driven snapshots.
- [x] Connect `subagent_output`.
- [x] Connect session portions of `subagent_status`.
- [x] Add progress, repeat-read, ordering, and ID-domain tests.

Satisfies: S6, S25–S30, A2, A5

Depends on: T2

## T4. Resume and steer

- [x] Implement terminal-session resume with one-turn enforcement.
- [x] Implement running-session steer acknowledgement.
- [x] Reject agent overrides on resume and all configuration overrides on steer.
- [x] Add valid, invalid-state, failure, and race tests.
- [x] Verify with a real 003 `RecordStore` reload fixture that a terminal snapshot with no live handle fails resume with `SESSION_NOT_RESUMABLE` and steer per S12 with `SESSION_NOT_RUNNING`.

Satisfies: S7–S14, S22, A3–A4

Depends on: T3

## T5. Shutdown

- [x] Register one awaited handler for all Pi shutdown reasons and synchronously close/memoize namespace admission.
- [x] Abort active child-session records through public `AgentSession.abort()` and settle shutdown/terminal races through one per-record gate.
- [x] Drain owned execution/progress, persist and publish deterministic aborted transitions, preserve observed fields, and isolate abort/persistence/cleanup failures.
- [x] Preserve terminal records, inspection, namespace independence, and restart-normalized data-only behavior.
- [x] Add public abort delegation, lifecycle wiring, adversarial race, and failure integration tests.
- [x] Complete focused and full lint/typecheck/test/build verification.

Satisfies: S23, S45–S50, A8

Depends on: T4

## T6. Bounded child failure diagnostics

- [x] Inspect Pi 0.84.2 assistant/session event types and capture only observable stop fields.
- [x] Distinguish assistant error stops from prompt throws without changing the public child-failure code/message.
- [x] Omit all provider raw/error text and thrown values from diagnostics.
- [x] Add focused assistant-stop, prompt-throw, success-regression, provider-controlled text, and malformed-Unicode classification tests.
- [x] Complete focused and full lint/typecheck/test/build verification.

Satisfies: S51–S52, A9, `003-record-storage/S22`–`003-record-storage/S23`

Depends on: T2, `003-record-storage/T1`

## T7. Per-agent extension isolation and tools

- [x] Resolve safe local extension sources with project/global precedence, Pi 0.84.2 manifest glob/exclusion plus package convention/ignore semantics, canonical file/type checks, and physical containment before Pi import.
- [x] Resolve unversioned npm package names only from existing Pi-managed project/user installs, reject version suffixes, and fail without install or temporary fallback.
- [x] Load selected extensions before final built-in/extension tool allowlist validation and allocation.
- [x] Fail loader errors, missing sources, and conflicts with a stable redacted code.
- [x] Preserve exact omitted/empty/explicit tool and extension semantics and retained-child resume behavior.
- [x] Own pending/prepared extension resources across setup, persistence, admission, creation, and shutdown races with exactly-once disposal or child transfer.
- [x] Add focused fake/local-fixture and real-loader/session tests for patterns, exclusions, conventions, ignores, side-effect isolation, lifecycle, and tools without credentials, external package installation, or network access.
- [x] Complete full lint/typecheck/test/build verification.

Satisfies: R24, S53–S56, A10, `001-agent-registry/S19`–`001-agent-registry/S20`

Depends on: T2, T4, `001-agent-registry/T4`

## T8. Resume model/thinking overrides (historical baseline, superseded by T9 precedence)

- [x] Resolve optional resume overrides from retained effective settings without reapplying agent/config/parent precedence.
- [x] Reconfigure the retained child through public Pi model/thinking APIs after queued persistence and admission, before running persistence and prompt.
- [x] Preserve omitted settings, reject unsupported combinations before mutation, and terminalize post-acceptance configuration failures without prompting or retaining an uncertain resumable child.
- [x] Keep steer override rejection unchanged and update tool-schema guidance.
- [x] Add resolver, runner, lifecycle, persistence-order, shutdown, and retention tests.
- [x] Complete full lint/typecheck/test/build verification; independent review is tracked separately.

Satisfies: R7, R16, R18, C4, S7–S11, S21, S38, S56, A3

Depends on: T1, T4

## T9. Agent-first shared precedence for new and resume

- [x] Use one independent agent → call → config → current-parent resolver for model and thinking on both new and resume.
- [x] Remove retained model/thinking and built-in `off` fallbacks; return coded errors when all model or thinking layers are absent.
- [x] Look up only the retained agent name's normalized model/thinking metadata after resume visibility/resumability checks, including disabled definitions.
- [x] Reconfigure the retained child only when freshly resolved effective values differ, while preserving child/extensions/tools/system prompt/conversation identity.
- [x] Update tool-schema guidance and replace retained-baseline tests/specification claims.
- [x] Complete full lint/typecheck/test/build verification.
- [x] Complete independent review.

Satisfies: R7, R12, R16, R18, C1–C4, S2, S7–S10, S15–S21, S56, A3, A6–A7

Depends on: T8

## T10. Activation-scoped registry consumption

- [x] Share one activation-captured normalized registry across list, new, and resume.
- [x] Keep resume lookup after visibility/resumability checks while eliminating per-resume filesystem reads.
- [x] Preserve agent → call → config → current-parent precedence and retained child/extensions/tools behavior.
- [x] Complete full lint/typecheck/test/build validation.
- [x] Complete independent review.

Satisfies: R7, R16, R18, C4, S2, S7–S8, S15, S56, A3, A6

Depends on: `001-agent-registry/T5`, T9
