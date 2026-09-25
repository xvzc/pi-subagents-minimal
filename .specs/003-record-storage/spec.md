# Specification: Record Storage

## Layout

```text
<agent-dir>/subagents-state/
└── <project-key>/
    └── <parent-session-id>/
        └── sessions/
            └── ses_<id>.json
```

- **S1:** `project-key` is a stable hash of the canonical project path and contains no raw path traversal segments.
- **S2:** Parent-session IDs and run IDs are sanitized/validated before path construction.
- **S3:** Session paths remain under the resolved namespace root.

## Record Envelope

```ts
interface StoredRecord<T> {
  version: 1;
  kind: "session";
  data: T;
}
```

- **S4:** Persisted data contains status, metadata, effective model/thinking where applicable, output, error, available usage, progress, and timestamps.
- **S5:** Persisted data excludes Pi session objects, workers, promises, abort controllers, callbacks, and precedence-source labels.
- **S6:** Unknown record versions are skipped with warnings rather than interpreted.

## Writes and Reads

- **S7:** Material transitions are written using temporary-file plus atomic rename in the destination directory.
- **S8:** Directories use mode `0700` and files use `0600` where supported.
- **S9:** On activation or parent-session resume, valid records in that namespace are loaded.
- **S10:** Corrupt, mismatched-kind, or schema-invalid files are skipped with path-specific warnings; other records still load.
- **S11:** Diagnostic logs contain paths/reasons but never record output, results, prompts, or error payload contents.
- **S12:** Repeated reads do not mutate or delete records.

## Retention

- **S13:** A terminal record expires when `now - completed_at >= historyRetentionDays * 24h`.
- **S14:** Active records are exempt regardless of age.
- **S15:** Cleanup runs during extension activation and after any session reaches a terminal state.
- **S16:** Cleanup applies to session files in the active project namespace.
- **S17:** With no override, `historyRetentionDays` is 7.
- **S18:** A deleted or never-existing record is reported by its owning output tool as not found.

## Restart Semantics

- **S19:** Reloaded records are available to output and status tools.
- **S20:** Reloaded session records have no live conversation handle and are not resumable or steerable.
- **S21:** A persisted active record found after process restart is normalized to `aborted` with a restart-interruption error and persisted before exposure.

## Stored Failure Diagnostics

- **S22:** `error` continues to require `code` and `message` and optionally accepts exactly `{ phase: "assistant_stop", assistant_turn: positiveSafeInteger, stop_reason: "error" }` or `{ phase: "prompt_throw" }`. Missing, additional, or differently valued diagnostic fields are rejected, including `raw_stop_reason`.
- **S23:** Version-1 records whose error contains only `code` and `message` remain valid without migration. Diagnostics contain no provider raw/error message, thrown value, prompt, assistant content, stack trace, header, credential, or arbitrary exception object.
- **S24:** Version-1 session snapshots remain unchanged for per-agent extensions: neither configured extension source strings, resolved paths, loaded extension objects, resource loaders, nor registered tool definitions are persisted. Resume uses only the retained process-local child.

## Acceptance Criteria

- **A1:** Atomic writes survive a simulated interrupted temporary write without corrupting the prior record.
- **A2:** Restart reload restores valid session output and skips corrupt/unknown-version files.
- **A3:** Exactly-at-boundary expired terminal records are removed; newer and active records remain.
- **A4:** State files remain under the root and use owner-only permissions where supported.
- **A5:** Reloaded terminal sessions are inspectable but fail resume as non-resumable.
- **A6:** Persisted active records become aborted after restart rather than appearing perpetually running.
- **A7:** Schema tests accept legacy errors and both exact diagnostic shapes while rejecting missing, malformed, or additional diagnostic fields.
- **A8:** Extension-enabled session tests prove queued/running/terminal snapshots retain the existing schema and contain no extension source or loader state.
