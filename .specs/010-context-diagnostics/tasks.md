# Tasks: Context-Based Diagnostics

## T1. Diagnostic adapter and pre-context collection

- [x] Add a safe context/UI warning adapter with no console fallback.
- [x] Route configuration diagnostics through an explicit callback.
- [x] Collect activation diagnostics and flush them once per parent namespace at `session_start`.

Satisfies: R1-R2, R5, N1-N3, C1, C3, S1-S9

## T2. Runtime and view routing

- [x] Route session-manager warnings through the affected operation or record context.
- [x] Route Agents-view warnings through its existing UI context.
- [x] Preserve existing warning messages, guards, and runtime behavior.

Satisfies: R3-R5, N1-N4, C1-C4, S10-S15

Depends on: T1

## T3. Verification

- [x] Update focused tests from console spies to UI notification assertions.
- [x] Add coverage for deferred activation diagnostics and notification failure isolation.
- [x] Confirm production source contains no console or direct stdout/stderr diagnostics.
- [x] Run format, lint, typecheck, full tests, and build.

Satisfies: N5, A1-A5

Depends on: T1-T2
