# Tasks

## T1. Spec artifacts as source of truth

- [x] Rewrite `requirements.md`, `spec.md`, and `design.md` for detailed
  tool `description` strings (ownership, purpose-sentence plus
  complexity-proportional sections, no `promptGuidelines`/`promptSnippet`/
  `before_agent_start`, no behavior change).

Satisfies: R1-R10, C1-C2, S1-S8

## T2. Tool definitions and guideline removal

- [x] Replace the four `SUBAGENT_*_GUIDELINES` arrays with detailed
  Markdown `description` strings assigned inline on each tool's
  `defineTool({...})` in `src/index.ts` (`createTools`); remove every
  `promptGuidelines` field. No `SUBAGENT_*_DESCRIPTION`
  variables/constants remain.

Satisfies: S1-S8, R1-R10, C1-C2

## T3. Tests and verification

- [x] Delete `test/prompt-guidelines.test.ts`; add
  `test/tool-descriptions.test.ts`: per-tool inline description text read
  off the registered tools, purpose-sentence plus section scaling, full
  semantics in the correct owner, no cross-tool duplication, no
  unavailable names, no `promptGuidelines`/`promptSnippet`/
  `SUBAGENT_*_GUIDELINES`/`SUBAGENT_*_DESCRIPTION`, no
  `before_agent_start` registration with existing handlers intact.
- [x] Run focused tests, full tests, typecheck, lint, and build; record
  results in `verification.md`.

Satisfies: A1-A3

## T4. Single-file root-owned tools (reversal of the modular split)

- [x] Keep all four tool definitions, the `TOOL_NAMES`/`ToolName` surface,
  the exact-order `createTools` aggregator, the tool-boundary helpers, and
  the `subagent_call` presentation/render state in `src/index.ts` with each
  `description` assigned inline. No `src/tools/` modules and no
  `test/tools-split.test.ts` remain. No description, schema, execution,
  rendering, config, or handler change.
- [x] Update ownership references in `design.md`/`spec.md` S1 and
  `.specs/000-foundation/design.md`; record results in `verification.md`.
