# Tasks: Record Storage

## T1. Paths and stored schemas

- [x] Implement canonical project hashing and contained namespace paths.
- [x] Define versioned session envelopes.
- [x] Validate IDs and stored record schemas.
- [x] Add traversal, namespace, version, and schema tests.

Satisfies: S1–S6, A4

Depends on: `000-foundation/T1`

## T2. Atomic record store

- [x] Implement atomic writes and restrictive permissions.
- [x] Implement independent session loading.
- [x] Return path-only diagnostics for invalid records.
- [x] Normalize interrupted active records to aborted.
- [x] Add interrupted-write, reload, corruption, permissions, and restart tests.

Satisfies: S7–S12, S19–S21, A1–A2, A5–A6

Depends on: T1

## T3. Retention cleanup

- [x] Implement elapsed-day expiration using effective config.
- [x] Exempt active records.
- [x] Run cleanup on activation and terminal settlement.
- [x] Add before/exactly/after-boundary and failure tests.

Satisfies: S13–S18, A3

Depends on: T2, `000-foundation/T2`

## T4. Backward-compatible child failure diagnostics

- [x] Extend stored errors with an optional fixed diagnostic shape.
- [x] Enforce the two exact phase-specific diagnostic shapes and reject every extra field.
- [x] Verify legacy version-1 errors remain accepted.
- [x] Add valid, missing-field, invalid-stop, and forbidden raw/message field tests.
- [x] Complete full lint/typecheck/test/build verification.

Satisfies: S22–S23, A7

Depends on: T1, `002-subagent-runtime/T6`

## T5. Keep extension runtime state out of records

- [x] Reuse the existing version-1 session snapshot unchanged.
- [x] Verify extension-enabled lifecycle writes do not contain sources, loaders, or tool definitions.

Satisfies: R7, S24, A8

Depends on: T2, `002-subagent-runtime/T7`
