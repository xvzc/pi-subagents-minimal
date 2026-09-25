# Design: Configurable Coordination Guideline Injection

## Overview

Keep configuration parsing in `src/config.ts` and the effective shape in `src/types.ts`. Store the embedded coordination block in a small responsibility-focused source module. Bind one host-edge `before_agent_start` handler during extension activation only when the already-loaded immutable effective config enables injection.

## Components

- **Configuration:** `injectGuidelines` is a required effective boolean with default `true`; existing global/project merge and warning rules apply.
- **Embedded guideline module:** owns the exact `<agent-coordination>` block and a pure append helper. The helper returns the original prompt unchanged or an optional replacement according to S4, S5, and S8.
- **Activation wiring:** `src/index.ts` registers the prompt handler after effective config loading. Disabled configuration does not register this handler.
- **Tests:** focused pure/helper or activation tests capture registered handlers and assert missing, present, disabled, and empty-prompt cases without starting a child session.

## Decisions

- **Embedded snapshot rather than runtime read:** avoids filesystem/path/error behavior and keeps deployments deterministic.
- **Exact-block deduplication:** respects host-provided copies and prevents duplicate policy text in the same turn.
- **Conditional registration:** makes `false` an observable absence of injection behavior and avoids unnecessary hook work.
- **Parent-only host hook:** leaves `SessionManager` child prompt construction untouched.

## Compatibility

The change intentionally supersedes `006-coordination-prompt` clauses that prohibited `before_agent_start`. It does not remove or rewrite existing schema/tool guidance and does not change public tool shapes.
