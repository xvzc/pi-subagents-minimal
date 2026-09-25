# Requirements: Prefixless 64-Bit Session IDs

## Goal

Replace verbose `ses_${UUID}` identifiers with compact, prefixless, uniformly
random 64-bit identifiers formatted as lowercase hexadecimal
`xxxxxxxx-xxxx-xxxx`, with strict validation and bounded collision retry.

## Functional Requirements

- **R1:** Every newly allocated subagent session ID has exactly 16 lowercase
  hexadecimal digits grouped `8-4-4`, for example
  `a1b2c3d4-e5f6-0718`.
- **R2:** IDs are generated from 8 cryptographically random bytes; formatting
  does not reduce the 64-bit value space.
- **R3:** Allocation checks process-local live/loaded session records and retries
  a colliding candidate before any session mutation or persistence.
- **R4:** Runtime, storage, and path validation accept only the new format.
  Legacy `ses_...` IDs are intentionally unsupported and rejected.
- **R5:** Every public tool and persisted snapshot continues to use the shared
  `session_id` field without adding aliases or migration metadata.

## Non-Functional Requirements

- **N1:** ID allocation is bounded and cannot loop indefinitely if generation is
  faulty or repeatedly collides.
- **N2:** Allocation failure is atomic: no record, file, child, slot, waiter, or
  notification is created.
- **N3:** The format is safe as one filename stem with no normalization or
  escaping.
- **N4:** No production dependency, durable global counter, process lock, storage
  migration, or compatibility layer is introduced.
- **N5:** Format, generation, collision, exhaustion, persistence, loading, and
  public-tool behavior have automated coverage.

## Constraints

- **C1:** This is an approved breaking change; existing `ses_...` records may be
  rejected by loaders and are not migrated.
- **C2:** Parent Pi session IDs and directory namespace rules are unchanged.
- **C3:** Public parameter schemas continue to expose session IDs as strings so
  malformed IDs reach the existing `SESSION_NOT_FOUND` runtime contract rather
  than a host schema error.
- **C4:** Invalid generated candidates or retry exhaustion return a redacted
  existing `INTERNAL_ERROR` contract before mutation.

## Non-Goals

- Backward compatibility with `ses_...` IDs.
- Migration or renaming of existing record files.
- Sequential IDs, counters, locks, timestamps, sorting semantics, or embedded
  metadata.
- Security-token or authorization semantics for session IDs.
- Changes to parent namespace isolation or storage layout beyond the filename
  stem format.

## Assumptions

- Node.js cryptographic random-byte generation is available in every supported
  runtime.
- Process-local collision checks are proportionate for a 64-bit random space;
  no durable global ID index is required.

## Unresolved Questions

None.
