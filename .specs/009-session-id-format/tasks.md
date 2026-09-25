# Tasks: Prefixless 64-Bit Session IDs

Scope: breaking hard cutover to random lowercase hexadecimal `8-4-4` IDs. No
legacy compatibility, migration, sequential counter, lock, timestamp, or new
production dependency.

## T1. Shared format and generator

- [x] Replace prefix-based ID constants/guards with the exact S1 format.
- [x] Generate formatted IDs from exactly 8 cryptographically random bytes.
- [x] Add focused valid/invalid and deterministic formatting tests.

Satisfies: R1–R2, N3, S1–S5, A1–A2

## T2. Collision-safe allocation

- [x] Allocate through a pre-mutation 16-attempt collision loop while preserving
  the injected generator seam.
- [x] Fail invalid generated values and exhaustion with existing
  `INTERNAL_ERROR` before any state or external side effect.
- [x] Add collision, invalid-output, exhaustion, and side-effect-absence tests.

Satisfies: R3, N1–N2, C4, S6–S9, A3–A4

Depends on: T1

## T3. Storage and hard cutover

- [x] Update path and persisted-record validators, loader diagnostics, fixtures,
  and filename expectations to the exact new format.
- [x] Reject legacy `ses_...` public inputs and stored records; add no migration
  or fallback behavior.
- [x] Update new/resume/steer/output/wait/status/retention/notification/abort
  suites to valid new IDs while preserving behavioral assertions.

Satisfies: R4–R5, N4–N5, C1–C3, S10–S12, A5–A6

Depends on: T1–T2

## T4. Verification and review

- [x] Run format, lint, typecheck, focused format/allocation/storage/runtime
  tests, full tests, and build.
- [x] Record exact evidence and any unrelated baseline failure in
  `verification.md`.
- [x] Complete independent review of format, randomness, collision atomicity,
  storage/path safety, and regression coverage.

Satisfies: A7

Depends on: T1–T3
