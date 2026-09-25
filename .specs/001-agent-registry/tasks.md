# Tasks: Agent Registry

## T1. Metadata schema and normalization

- [x] Implement strict known-field, frontmatter, and body validation.
- [x] Normalize all supported fields into `AgentDefinition`.
- [x] Silently ignore unknown keys and reject every invalid known-field class.
- [x] Add exhaustive metadata unit tests.

Satisfies: S5–S16, A2–A3

Depends on: `000-foundation/T1`

## T2. Discovery and precedence

- [x] Discover all three source layers in deterministic order.
- [x] Merge valid definitions with project precedence.
- [x] Preserve disabled overrides.
- [x] Collect path-specific warnings.
- [x] Add empty, precedence, duplicate, and filesystem-failure tests.

Satisfies: S1–S4, A1, A4–A5

Depends on: T1

## T3. `subagent_list`

- [x] Connect the registry to the public tool.
- [x] Return sorted enabled summaries and warnings.
- [x] Add tool-level contract tests.

Satisfies: S17–S18, A1–A5

Depends on: T2

## T4. Per-agent extension metadata

- [x] Normalize supported `npm:` and safe relative `path:` sources fail-closed.
- [x] Preserve omitted versus explicit-empty extension lists.
- [x] Expose configured source strings in list output and rendering without resolved paths.
- [x] Add focused metadata and list/rendering tests.

Satisfies: R5, S19–S20, A6

Depends on: T1, T3

## T5. Activation-scoped registry snapshot

- [x] Load and normalize agent discovery once when the bound registry is constructed during extension activation.
- [x] Share the captured snapshot across list, enabled new-session lookup, and unfiltered retained-session metadata lookup.
- [x] Return defensive copies so callers cannot mutate captured definitions, nested arrays, or warnings.
- [x] Replace live-reload tests with stable-within-activation and refresh-on-reactivation coverage.
- [x] Complete full lint/typecheck/test/build validation.
- [x] Complete independent review.

Satisfies: R6, N4, S21–S22, A7

Depends on: T2, T3

## T6. Session-start warning notification

- [x] Capture the activation snapshot's warning count without rescanning agent files.
- [x] Notify once per parent-session namespace with a fixed aggregate warning and `subagent_list` guidance.
- [x] Keep session restore behavior and detailed `subagent_list` warnings unchanged.
- [x] Add clean, warning, namespace-deduplication, and notification-failure tests.
- [x] Complete focused and full validation.
- [x] Complete independent review.

Satisfies: R7, N5, S23–S24, A8

Depends on: T5
