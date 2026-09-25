# Tasks: Agent Capability Selection

## T1. Define the capability contract

- [x] Record allow/default/deny semantics for tools and skills.
- [x] Define compatibility and error behavior.
- [x] Define the public list and runtime contracts.

Satisfies:
- R1-R7
- S1-S16

## T2. Implement normalized metadata and listing

- [x] Add normalized tool and skill policy parsing and types.
- [x] Preserve policies through registry snapshots and defensive copies.
- [x] Expose and render normalized list policies.
- [x] Add focused parser, registry, and rendering tests.

Satisfies:
- S1-S4
- S11-S16
- A1-A2

Depends on:
- T1

## T3. Enforce runtime capability policies

- [x] Build post-load tool and skill catalogs.
- [x] Validate and resolve allow-minus-deny policies before allocation.
- [x] Enforce resolved tools and filtered resource-loader skills.
- [x] Preserve preparation cleanup and retained-session behavior.
- [x] Add focused runtime and integration tests.

Satisfies:
- S5-S10
- S16
- A3-A6

Depends on:
- T2

## T4. Verify the integrated change

- [x] Run formatting, lint, type checking, tests, and build.
- [x] Record criterion-level evidence in `verification.md`.

Satisfies:
- A1-A7

Depends on:
- T3
