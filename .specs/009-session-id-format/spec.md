# Specification: Prefixless 64-Bit Session IDs

This feature supersedes `000-foundation`, `002-subagent-runtime`, and
`003-record-storage` wherever those features require a `ses_` prefix or UUID
session suffix. All unaffected contracts remain in force.

## Format and Validation

- **S1:** A valid subagent session ID matches exactly:

  ```regex
  ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}$
  ```

  It is 18 characters containing 16 lowercase hexadecimal digits and two
  literal hyphens.
- **S2:** Uppercase hex, missing/extra groups, non-hex characters, UUID-length
  values, bare 16-digit hex, and every `ses_...` value are invalid.
- **S3:** `SessionId`, `isSessionId`, path validation, stored-envelope
  validation, runtime action validation, loading, and test fixtures use the
  same exact format contract.
- **S4:** Public TypeBox parameter schemas keep session IDs as plain strings.
  Invalid public inputs continue to return `SESSION_NOT_FOUND` from runtime
  validation without revealing namespace membership.

## Generation and Allocation

- **S5:** The default generator reads exactly 8 cryptographically random bytes,
  converts them to 16 lowercase hexadecimal digits, and formats digit slices
  `[0,8)`, `[8,12)`, and `[12,16)` as `8-4-4`.
- **S6:** `new` allocation validates each generated candidate and checks the
  `SessionManager` record map before any record insertion, queued write, slot
  reservation, child preparation/creation, or public acceptance.
- **S7:** A valid non-colliding candidate is used unchanged. A candidate already
  present in the manager retries generation. At most 16 candidates are tried.
- **S8:** An invalid generated candidate or 16 consecutive collisions fails with
  existing `INTERNAL_ERROR` and leaves all process-local, persistent, child,
  queue, wait, notification, and view state unchanged.
- **S9:** The injected test generator seam remains supported but must satisfy the
  same validation, collision, and bounded-allocation behavior as production.

## Storage and Compatibility

- **S10:** Session files use `<session_id>.json` under the existing
  parent-namespace directory, for example
  `sessions/<parent>/a1b2c3d4-e5f6-0718.json`.
- **S11:** Record parsing and directory loading reject legacy or malformed
  snapshot IDs and filenames using existing warning/skip behavior. There is no
  migration, alias, or fallback parser.
- **S12:** Parent session ID validation, atomic writes, restart normalization,
  retention, output, status, resume, steer, wait, completion push, and operation
  abort behavior are unchanged apart from accepting/emitting the new ID format.

## Acceptance Criteria

- **A1:** Default generation deterministically maps a stubbed 8-byte value to
  the expected lowercase `8-4-4` ID and valid generated IDs satisfy S1.
- **A2:** The validator accepts representative boundary-valid IDs and rejects
  uppercase, malformed, UUID-length, bare-hex, path-unsafe, and `ses_...` IDs.
- **A3:** A generated collision retries and the next valid unique candidate is
  accepted; no state from the colliding attempt is created.
- **A4:** Invalid generated candidates and 16 consecutive collisions return
  `INTERNAL_ERROR` before any write, child creation, queue/slot acquisition,
  waiter change, or notification.
- **A5:** New, resume, steer, output, wait, status, persistence, restart loading,
  retention, completion notification, and operation abort tests use and preserve
  the new format.
- **A6:** Legacy `ses_...` public inputs and stored records are rejected without
  migration or compatibility behavior.
- **A7:** Format check, lint, typecheck, focused tests, full tests, build, and
  independent review pass apart from explicitly documented unrelated baseline
  failures.
