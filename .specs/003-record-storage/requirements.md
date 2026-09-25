# Requirements: Record Storage

## Goal

Persist serializable session state so status and output remain inspectable after extension restart, while automatically removing expired terminal records.

## Functional Requirements

- **R1:** Material session state transitions must be written to files.
- **R2:** Persisted records for a resumed parent session must be reloadable.
- **R3:** Terminal records older than configured retention must be deleted automatically.
- **R4:** Active records must never be removed by retention cleanup.
- **R5:** Storage failures must be diagnosable without exposing record contents.
- **R6:** Stored child execution failures may carry bounded, non-sensitive diagnostics while records written before diagnostics existed remain readable.
- **R7:** Per-agent extension source configuration remains creation-only and must not broaden the persisted session schema or expose resolved source paths.

## Non-Functional Requirements

- **N1:** Readers must never observe partially written JSON.
- **N2:** State paths must not escape the configured state root.
- **N3:** State files and directories must be owner-only where supported.
- **N4:** Live process objects must never be serialized.
- **N5:** Persistent diagnostics must enforce exact finite shapes with no provider-controlled text fields.

## Constraints

- **C1:** Root: `<agent-dir>/subagents-state/`.
- **C2:** Namespace: stable project key followed by parent-session ID.
- **C3:** Default retention is 7 elapsed 24-hour periods from terminal `completed_at`.
- **C4:** Persistence enables restart-safe inspection, not restart-safe resume or steer.

## Non-Goals

- Database storage
- Cross-machine synchronization
- Encryption at rest
- Persistent Pi child conversation restoration
- Manual cleanup UI/tool

## Assumptions

- The Pi agent directory is writable.
- Session managers supply serializable snapshots.

## Unresolved Questions

None.
