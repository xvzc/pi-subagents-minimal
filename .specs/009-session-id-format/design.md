# Design: Prefixless 64-Bit Session IDs

## Overview

Centralize the new exact format in the existing shared ID utilities and replace
the default UUID allocator with an 8-byte cryptographic random generator. Add a
bounded allocator in `SessionManager` that validates candidates and retries
process-local collisions before the existing new-session pipeline mutates state.
Storage and public consumers continue to share the same `session_id` value.

```text
src/
├── types.ts                    # SessionId pattern/type guard and formatter
├── runtime/session-manager.ts  # default generator + bounded allocation
└── storage/
    ├── paths.ts                # filename/path validation
    └── schemas.ts              # persisted snapshot validation
```

## Components

### Shared ID contract (`types.ts`)

- Replace `SESSION_ID_PREFIX` semantics with an exported exact
  `SESSION_ID_PATTERN` or equivalent shared predicate.
- `SessionId` remains a branded string type; `isSessionId` accepts only S1.
- A small production generator reads `randomBytes(8)`, hex-encodes, and inserts
  hyphens after digits 8 and 12. It may live in `types.ts` or the manager module,
  but format logic has one tested implementation.

### Bounded allocation (`session-manager.ts`)

- Preserve the injectable `createId` test seam.
- Add `allocateSessionId()` before any new-session record construction:

  ```text
  repeat up to 16 times
    candidate = createId()
    invalid candidate → fail INTERNAL_ERROR
    records.has(candidate) → retry
    otherwise return candidate
  exhaustion → fail INTERNAL_ERROR
  ```

- Invalid candidates fail rather than retry because they indicate a broken
  generator contract; collisions alone retry.
- Allocation occurs only after existing request/agent/model validation but
  before extension preparation, record insertion, persistence, queueing, or
  child creation.

### Storage (`storage/paths.ts`, `storage/schemas.ts`)

- Replace prefix-aware validators with the exact shared format contract or an
  equivalent dependency-safe regex.
- File paths remain `<session-id>.json`; the restricted lowercase hex/hyphen
  alphabet is inherently a safe single path component.
- Loader warnings describe the new expected form without echoing sensitive
  values. Legacy records follow existing invalid-record skip behavior.

### Public tools and documentation

- Tool parameter schemas remain plain strings.
- Descriptions refer to session IDs without promising a `ses_` prefix.
- Update all repository fixtures and exact assertions to valid deterministic
  `8-4-4` IDs; helpers should make repeated fixture creation readable.

## Decisions

### D1. Random rather than sequential

Random 64-bit allocation avoids durable shared counters, cross-process locks,
crash reservation gaps, and backup rollback semantics. A collision check and
bounded retry cover process-local safety.

### D2. Hard cutover

The user explicitly approved no compatibility. One strict parser prevents dual
formats from persisting indefinitely and keeps every runtime/storage contract
aligned.

### D3. Plain-string public schemas

Runtime-coded `SESSION_NOT_FOUND` is an existing public contract. Tightening the
host TypeBox schema would change malformed-ID errors and leak validation timing,
so schemas stay permissive strings.

### D4. Sixteen collision attempts

Sixteen attempts are effectively unreachable under a healthy 64-bit generator
but bound faulty injected or compromised randomness. Invalid generator output
fails immediately instead of obscuring a programming error.

## Failure Handling

- Cryptographic random generation failure is sanitized to `INTERNAL_ERROR` at
  the existing safe tool boundary.
- Invalid generated shape and retry exhaustion explicitly throw redacted
  `INTERNAL_ERROR` before mutation.
- Malformed/legacy public IDs return `SESSION_NOT_FOUND`.
- Malformed/legacy stored records warn and skip under existing loader behavior.

## Trade-offs

- IDs are not chronologically sortable.
- A 64-bit random space is smaller than UUIDv4, so collision retry is mandatory;
  process-local checks are accepted instead of a durable global index.
- Existing unpublished `ses_...` development records become unreadable by
  design.
