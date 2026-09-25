# Tasks: Interruptible Subagent Wait

Scope: one new public tool and process-local waiter lifecycle. No widget,
timeout, completion mode, sticky re-wait, storage migration, production
dependency, or changes to completion delivery.

## T1. Public wait contract

- [x] Add `SubagentWaitSchema`, parameter/result types, service boundary, and
  public tool registration.
- [x] Keep `session_ids` as the only parameter and document all-session,
  interruptible, snapshot-based behavior.
- [x] Update public tool-count/description/contract tests.

Satisfies: R1, R6, C1, S1–S3, S11, A6

## T2. Race-free waiter lifecycle

- [x] Add one active waiter per namespace with register-before-project startup,
  ordered snapshot projection, idempotent settlement, and listener cleanup.
- [x] Refresh waiters from every authoritative terminal publication path.
- [x] Support immediate completion for already-terminal records and fresh
  snapshot-based re-wait after an interruption gap.
- [x] Add focused tests for all-terminal joins, immediate completion, ordering,
  lost-wakeup races, re-wait, namespace isolation, and waiter collisions.

Satisfies: R2, R4, N1–N3, C2–C3, S4–S8, A1–A2, A4–A6

Depends on: T1

## T3. Input interruption and abort integration

- [x] Extend the existing interactive/RPC input path to interrupt a waiter
  without handling or transforming the submitted input; exclude extension
  input.
- [x] Bind and observe operation abort, preserve namespace-wide child
  cancellation, and clean waiters during shutdown.
- [x] Add focused input pass-through, child-survival, already-aborted,
  operation-abort, shutdown, and competing-settlement race tests.

Satisfies: R3, R5, N2, C4–C5, S9–S10, S12–S13, A3, A5, A7

Depends on: T2

## T4. Compatibility and verification

- [x] Prove existing completion pushes, polling projections, persistence,
  concurrency, views, and existing tool contracts remain unchanged.
- [x] Run format check, lint, typecheck, focused tests, full tests, and build.
- [x] Record exact results and unrelated baseline failures in
  `verification.md`; complete independent review.

Satisfies: N4–N5, S14–S15, A8

Depends on: T1–T3
