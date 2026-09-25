# Design: Record Storage

## Overview

A generic `RecordStore` persists serializable snapshots supplied by the session manager. It knows storage envelopes, paths, atomicity, validation, and retention, but not runtime behavior.

## Components

```text
src/storage/
├── paths.ts
├── schemas.ts
├── record-store.ts
└── retention.ts
```

### Paths

Resolve the agent state root, hash the canonical project path, validate parent/run IDs, and verify containment after joining.

### Schemas

Validate versioned stored envelopes separately from runtime objects. Version 1 is the only accepted MVP format. Stored errors keep required `code`/`message` and accept one of two exact optional child diagnostic shapes containing no provider-controlled text; omission preserves compatibility with prior version-1 records.

### Record Store

Atomically writes snapshots, loads valid files, applies restrictive permissions, and returns diagnostics without sensitive content.

### Retention

Computes expiration from terminal timestamps and the immutable effective configuration. It ignores active records.

## Interfaces

```ts
interface RecordStore {
  writeSession(snapshot: PersistedSession): Promise<void>;
  loadSessions(): Promise<LoadResult<PersistedSession>>;
  cleanup(now: number): Promise<CleanupResult>;
}
```

## Decisions

### D1. Application state outside project source

State lives under the Pi agent directory, avoiding untracked project files and accidental commits.

### D2. Atomic replacement

Temporary files are created beside the destination, flushed/closed, permissioned, and renamed. A failed replacement leaves the previous complete file intact.

### D3. Versioned envelopes

A top-level version and kind make future migrations explicit and prevent interpreting foreign JSON as a session.

### D4. Normalize interrupted active records

After process restart no worker or child session exists. Persisted active states become aborted before users inspect them.

### D5. Time-based retention

File-backed storage removes count-based eviction. A configurable day period bounds disk growth while preserving predictable access.

### D6. Owner-only physical storage boundary

Every directory from the configured state root through record namespaces is checked with `lstat`, hardened to `0700` where supported, and physically contained with `realpath` before sensitive I/O. Record leaves are rejected when linked or non-regular, and leaf opens use `O_NOFOLLOW` where supported. Checks are repeated before temporary creation, rename, read, and unlink. Ancestors outside the configured state root are not rejected merely for being symlinks.

Node does not expose the portable `openat`/directory-handle operations needed to eliminate every rename race from a hostile process running as the same owner. Owner-only ancestor permissions plus repeated physical checks define the supported trust boundary; lexical validation alone is not treated as proof against filesystem escape.

### D7. Additive version-1 error diagnostics

The optional diagnostic extends the existing error object without changing its required fields or envelope version. Runtime omits all provider and thrown text; schema validation enforces the exact phase-specific fields and rejects every additional key, including `raw_stop_reason`.

### D8. Extension configuration remains process-local

Selected source strings are registry/runtime configuration and resolved loaders/tools belong to the retained child handle. Existing version-1 session snapshots need no extension fields or migration; a reloaded data-only record remains inspectable but non-resumable.

## Failure Handling

- Write failure returns to the owning manager as an internal persistence error; the manager decides whether the run can continue.
- One corrupt file never blocks loading siblings.
- Cleanup failures warn and leave files intact.
- No automatic recovery deletes an unreadable file.
