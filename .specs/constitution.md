# Constitution

## Product Scope

- Keep the extension focused on direct subagent invocation and inspection.
- Add no user-facing capability unless it is declared in a feature specification.
- Prefer a small explicit API over compatibility with the full `pi-subagents` extension.

## Architecture

- Keep session records as distinct resources with `ses_` identifiers.
- Prefer explicit state and ownership over hidden global coupling.
- Keep the public tool layer separate from agent execution.
- Avoid abstractions intended only for hypothetical future features.

## Public API

- Public tool names, inputs, outputs, state transitions, and errors are contracts.
- Public API changes require an intentional specification update before implementation.
- Reject ambiguous invalid input rather than guessing, except where the specification explicitly defines ignore behavior.

## Dependencies

- Add production dependencies only when they directly satisfy a specified requirement.
- Prefer Pi host APIs and Node.js standard-library facilities over new dependencies.
- Pin development tooling sufficiently for reproducible validation.

## Testing

- Every externally observable behavior and error contract must have automated coverage when reasonably testable.
- State transitions, asynchronous behavior, and shutdown behavior require focused tests.
- Completion requires lint, type checking, tests, and build checks to pass.

## Compatibility

- The MVP has no backward-compatibility obligation to `pi-subagents`.
- Agent-file compatibility should be limited to the fields explicitly listed in the specification.
- Unsupported fields must not silently grant broader capabilities.

## Maintainability

- Keep implementation modules small and responsibility-oriented.
- Preserve traceability from requirements through specification, design, tasks, and verification.
- Do not silently alter requirements to accommodate implementation difficulties.
