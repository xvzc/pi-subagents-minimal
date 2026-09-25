# Tasks: Configurable Coordination Guideline Injection

- [x] **T1 — Configuration contract:** add and validate required boolean `injectGuidelines` with default `true`, precedence, fallback, and redacted warnings.
- [x] **T2 — Embedded guideline:** add the complete current `<agent-coordination>` block as an immutable source constant and implement deterministic append/deduplication behavior.
- [x] **T3 — Activation wiring:** conditionally register the parent `before_agent_start` handler from the effective config without changing child prompts or other handlers.
- [x] **T4 — Automated coverage:** cover enabled, disabled, deduplicated, empty-prompt, and non-empty separator behavior plus existing config cases.
- [x] **T5 — Verification:** run lint, type checking, tests, and build; record evidence in `verification.md`.
- [x] **T6 — Independent review:** review config gating, exact embedded content, hook behavior, duplication, scope, and validation adequacy.
