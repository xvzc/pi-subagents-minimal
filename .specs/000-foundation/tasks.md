# Tasks: Foundation and Configuration

## T1. Package scaffold

- [x] Create package metadata, TypeScript, lint, build, and Vitest configuration.
- [x] Add the Pi extension entry point.
- [x] Define shared IDs, run states, snapshots, errors, and service interfaces.
- [x] Register exactly the four public tools.
- [x] Add boot and schema contract tests.

Satisfies: S1–S7, S17, A1, A5

Depends on: none

## T2. Layered configuration

- [x] Implement centralized defaults and immutable effective config.
- [x] Load global then project JSON files.
- [x] Validate and merge fields independently.
- [x] Warn safely without exposing file contents.
- [x] Test defaults, precedence, malformed input, ranges, and unknown keys.

Satisfies: S8–S16, A2–A4

Depends on: T1
