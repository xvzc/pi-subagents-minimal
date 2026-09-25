# Tasks

## T1. Background-only call rendering

- [x] Keep pending/accepted (`»`) Agent Call rendering and expanded prompt.
- [x] Render pre-queue tool-level failures as literal `x Agent Call` with available identity; keep queued-then-background-failure as `»`.
- [x] Persist settled `failed` renderer state so settled replay/rendering is deterministic.
- [x] Render `new`/`resume` as background rows and `steer` as a modeless control row.
- [x] Make final `renderResult` cleanup and synchronize identity: empty without visible output for success, indented always-visible reason body for failure.
- [x] Sanitize/cap call failure reasons (message, else code, else generic label) at 120 characters with no inline heading suffix.
- [x] Emit partial identification updates for steer only; never for background `new`/`resume`.
- [x] Remove foreground entry appending (`turn_end` hook, entry type, entry renderer).

Satisfies: S1-S4, S7-S9, A1-A2

## T2. Completion signal and output presentation

- [x] Keep the Agent Output data projection, sanitization, safe fallback order (message, code, status, generic), 120-character reason cap, and 100,000-character cap as shared helpers.
- [x] Render retrieval errors and `failed`/`aborted`/`stopped`/error-field outcomes as literal `x Agent Output` with a heading-only row plus an always-visible indented reason body; keep `completed` as `«`.
- [x] Remove the completion custom-message renderer and its registration.
- [x] Render the fetched full result via `subagent_output` `renderResult`, preserving partial output alongside the visible reason without duplicating identical error text, and handling terminal output/errors/statuses and malformed/error envelopes safely.
- [x] Preserve hidden follow-up delivery (`triggerTurn`, `followUp`), model-context presence, and exactly-once behavior with the minimal signal.

Satisfies: S5-S8, A2-A3

## T3. Replay, export, and verification

- [x] Verify completion model-context presence and generic HTML export.
- [x] Cover rendering states, steer labeling, identity, and registration.
- [x] Run focused tests, lint, typecheck, full tests, and build.

Satisfies: S10, A1-A4

## T4. Always-visible failure reasons and export consistency

- [x] Show heading-only failure rows plus an indented sanitized 120-character reason even when collapsed (call and output).
- [x] Keep expanded prompt (call) and partial output (output) alongside the visible reason without duplicate identical error text.
- [x] Export the call failure reason in the result section; document the host-ordered header limitation (exported failed-call header may read `»`; interactive replay reads `x`).
- [x] Cover collapsed/expanded failures, status-only/code/generic fallbacks, sanitization/truncation, coexistence, replay, and export.
- [x] Run focused rendering tests, full tests, typecheck, lint, and build.

Satisfies: S1, S2, S5, S10, A1, A3, A4
