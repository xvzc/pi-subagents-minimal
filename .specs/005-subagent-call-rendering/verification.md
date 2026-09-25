# Verification

## Acceptance Criteria

| Criterion | Verification | Result |
|---|---|---|
| A1 | `test/subagent-call-rendering.test.ts` proves background spinner/accepted (`»`) states, heading-only pre-queue failure (`x`) states with an always-visible sanitized 120-character reason body (message, else code, else generic), queued-then-background-failure distinction, steer control rendering without an execution-mode label, prompt expansion with prompt/reason coexistence, identity synchronization, timer cleanup, settled interactive replay determinism (heading plus reason), empty final success results, and reason-bearing failure results | PASS |
| A2 | `test/agent-output.test.ts`, completion tests, and boot tests prove no custom entry is appended or registered at any lifecycle event, no message renderer is registered, no `sendMessage` fires from call rendering, and unchanged hidden background push behavior | PASS |
| A3 | `subagent_output` tool result renderer tests prove exact collapsed/expanded success (`«`, body only when expanded) and failure (`x`, heading-only plus always-visible reason) rows, terminal `failed`/`aborted`/`stopped`/error-field failure detection, the 120-character reason bound, partial-output-over-error priority with the reason kept visible, no duplicate identical error text when expanded, indentation, sanitization, safe malformed/error envelopes with code/status/generic fallbacks, and the 100,000-character expanded-body cap | PASS |
| A4 | Completion tests prove hidden background model-context presence; tool HTML tests prove generic custom-message export with no nested output representation; call export tests prove the failure reason is present in the exported result section | PASS |

## Host Limitations

- Standalone HTML export does not invoke custom message renderers, so background custom messages export generically. No nested tool output is emitted as a workaround.
- The host invokes `subagent_call` `renderCall` before `renderResult` with a fresh state and no error context, so a settled failed Agent Call may export its header as `»` while the failure reason (and, interactively, the `x` glyph) is carried by the exported result section. Interactive replay shows `x` plus reason deterministically; export determinism covers the result section only. This is a host ordering constraint, not fixable from this package without a host API change.

## Commands

- `npx vitest run test/agent-output.test.ts test/completion-notify.test.ts test/subagent-call-rendering.test.ts test/boot.test.ts` — PASS
- `npm run lint` — PASS
- `npm run typecheck` — PASS
- `npm run test` — PASS
- `npm run build` — PASS

Vitest emitted the existing Vite CommonJS/native-config advisory; it did not affect results.

## Unverified

None.
