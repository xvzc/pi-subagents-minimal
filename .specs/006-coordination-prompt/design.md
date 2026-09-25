# Design: Coordination Guidance via Tool Descriptions

## Overview

Remove the guideline constants and `promptGuidelines` metadata, add
detailed Markdown `description` strings assigned inline on each of the
four tool definitions in `src/index.ts`. The package root owns the tool
definitions (`TOOL_NAMES`/`ToolName`, exact-order `createTools`) alongside
activation/composition/event wiring and exports no description constants.
No service,
storage, schema, execution, rendering, handler-logic, or config changes.

```text
src/
└── index.ts                 # tool definitions with inline descriptions, createTools,
                              activation/composition/event wiring
test/
├── prompt-guidelines.test.ts  # DELETED (guideline contract obsolete)
└── tool-descriptions.test.ts  # description assignment, structure, semantics ownership, no prompt mechanism
```
## Components

### Inline descriptions (`src/index.ts` `createTools`)

- Four detailed Markdown strings, each assigned inline as its tool's
  `description` directly on its `defineTool({...})` call. No
  `SUBAGENT_*_DESCRIPTION` variables/constants exist and none are
  re-exported; tests read the text off the registered tools.
- Distribution: dispatch, selection, dependency/concurrency, and authority
  guidance lives once on `subagent_call`; retrieval, verification
  distinction, and completion-claim guidance lives on `subagent_output`
  with lifecycle limits on `subagent_status`; discovery guidance lives on
  `subagent_list`. The verification-distinction sentence is owned by
  `subagent_output`, not duplicated onto `subagent_call`; the status
  description points back to `subagent_output` for full results.
- Structure follows the pi-tasks pattern structurally only (never its
  domain content or wording): each description opens with one purpose
  sentence, then adds `##` sections proportional to the tool's complexity
  (`subagent_call` four sections, `subagent_output` two, `subagent_status`
  one, `subagent_list` concise with no sections).

### Registration (`src/index.ts` tool definitions and activation)

- No `promptGuidelines`, `promptSnippet`, or `pi.on("before_agent_start",
  …)` block exists. The `session_start`/`input`/`session_shutdown`
  handlers are untouched, so the `typeof pi.on === "function"` guard
  stays.

## Decisions

### D1. Inline strings next to the tool definitions

The guidance is tool metadata, not a shared service; assigning each
Markdown string inline on its `defineTool` call keeps the mapping obvious
without a new module or exported constants for single-use text.

### D2. Assign rather than duplicate

A tool's description is visible with that tool, so shared sentences are
placed where they matter most (dispatch on `subagent_call`, verification
on `subagent_output` with limits on `subagent_status`, discovery on
`subagent_list`) instead of repeated on every tool.

### D3. No configuration surface

The guidance restates implemented contracts; making it configurable would
let the prompt drift from actual behavior.
