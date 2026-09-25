# Verification: Record Storage

T1 (paths and stored schemas), T2 (record store), and T3 (retention) are
implemented and unit-tested.

| Criterion | Planned verification | Result |
|---|---|---|
| A1 | Atomic replacement/interrupted temporary write | PASS via `test/storage-record-store.test.ts` (pre-rename failure leaves prior record intact, temp cleaned, safe `INTERNAL_ERROR` without contents; the per-record in-process lock releases after failure and a later same-path replacement succeeds) |
| A2 | Restart reload, corruption, and version tests | PASS via `test/storage-record-store.test.ts` (session reload with exact envelopes; corrupt/unknown-version/kind-mismatch/schema-invalid/name-mismatch/unreadable skipped independently with fixed redacted warnings in lexical order; foreign records directories ignored; prior T1 unit coverage in `test/storage-schemas.test.ts` unchanged) |
| A3 | Seven-day boundary and active exemption | PASS via `test/storage-retention.test.ts` (default 7-day and custom 1-day expiry; before/exactly/after-boundary; all terminal statuses deleted; queued/running old records kept byte-identical with no normalization; final eligibility is re-read and revalidated under the shared per-record lock, with a deterministic expired-to-active replacement race proving the active bytes survive; future timestamps preserved with warnings; non-finite clocks rejected before deletion; sessions across multiple parent namespaces; invalid namespaces stray files ignored; activation hook integration via the awaited async extension factory) |
| A4 | Containment and permission tests | PASS (T1 lexical containment via `test/storage-paths.test.ts`; physical `lstat`/`realpath` containment and linked ancestor/directory/file rejection for write, load, and retention via POSIX cases in `test/storage-record-store.test.ts` and `test/storage-retention.test.ts`, with outside sentinels unchanged; owner-only `0700` on state root, project, parent, sessions and `0600` record files including after replacement) |
| A5 | Reloaded output plus data-only action-state test | PASS via `test/storage-record-store.test.ts` data-only round trips and the real `RecordStore` reload fixture in `test/session-manager.test.ts`: a reloaded terminal session remains inspectable, resume returns `SESSION_NOT_RESUMABLE`, and steer follows 002 S12 with `SESSION_NOT_RUNNING` (not `SESSION_NOT_RESUMABLE`) because no loaded terminal record is running |
| A6 | Active-to-aborted restart normalization | PASS via `test/storage-record-store.test.ts` (queued/running session records normalized to `aborted` with deterministic restart-interruption error and injected-clock `completed_at`, persisted before exposure; normalization failure warns and preserves the prior file) |
| A7 | Legacy and diagnostic error schema compatibility | PASS via `test/storage-schemas.test.ts` (legacy `{ code, message }`, exact valid diagnostics, missing/invalid fields, and forbidden provider raw/message fields) |

Validation:

```text
npm run lint       PASS
npm run typecheck  PASS
npm run test       PASS (13 files, 327 tests)
npm run build      PASS
```

Independent review: PASS. No blocking correctness, specification, security, scope, or validation findings remain. The documented same-owner cross-process pathname race is an accepted Node platform limitation.

## Child Diagnostic Checks

- `npx vitest run test/agent-runner.test.ts test/storage-schemas.test.ts` — PASS (2 files, 24 tests)
- `npm run lint` — PASS
- `npm run typecheck` — PASS
- `npm run test` — PASS (20 files, 474 tests)
- `npm run build` — PASS

## Final Phase 3 Checks

- `npm run lint` — PASS
- `npm run typecheck` — PASS
- `npx tsc -p tsconfig.build.json --noEmit` — PASS
- `npm test` — PASS (13 files, 327 tests)
- `npm run build` — PASS

The shared lock closes ordinary same-process RecordStore replacement versus retention-deletion races while preserving independence between record paths. Same-owner cross-process pathname races remain outside this guarantee because Node does not expose the portable `openat`/directory-handle operations needed to eliminate them; the owner-only and repeated physical-containment checks remain in force.

## T5 Extension-state exclusion

A8 PASS via `test/session-manager.test.ts`: an extension-enabled session writes the unchanged queued/running/terminal snapshots, and serialized writes contain neither configured npm source strings nor extension tool/resource state. Resume reuses only the retained child. Full lint/typecheck/test/build validation PASS.
