# Requirements: Coordination Guidance via Tool Descriptions

## Goal

Teach the parent model the extension's coordination policy through detailed
top-level Markdown tool `description` strings on the four active tool
definitions. No `promptGuidelines`, `promptSnippet`, or `before_agent_start`
prompt append remains.

## Functional Requirements

- **R1:** Coordination guidance is delivered only as tool `description`
  fields on the four active tool definitions. The extension registers no
  `before_agent_start` handler and sets no `promptGuidelines` or
  `promptSnippet` metadata.
- **R2:** Cross-cutting dispatch guidance lives on `subagent_call`:
  `new`/`resume` always background with prompt queued acceptance;
  `steer` is an immediate control operation; never sleep, wait, or
  repeatedly poll (when a hidden completion signal naming the session and
  status triggers a turn, retrieve that session via `subagent_output`;
  delivery is best-effort and no signal is promised for every settlement).
- **R3:** Session-selection discipline is on `subagent_call`: `new` for a
  fresh assignment, `resume` only to continue or correct the exact same
  retained live session, `steer` only on a currently running session.
- **R4:** Dependency and concurrency discipline is on `subagent_call`:
  dependent work starts only after its prerequisite output is collected and
  found sufficient, with failed/stopped/aborted or otherwise inadequate
  prerequisites requiring assessment and replanning rather than automatic
  dispatch, while independent work runs in parallel; one writer per
  workspace unless workspaces are genuinely isolated.
- **R5:** Authority discipline is on `subagent_call`: a child never exceeds
  parent/user authorization, unrelated files and changes are preserved, and
  secrets the child does not need are never passed.
- **R6:** Relevant retrieval/verification guidance is assigned to
  `subagent_output` and `subagent_status` rather than duplicated:
  `subagent_output` retrieves the child's report without consuming it and
  the report is not verified evidence; `subagent_output` retrieves the
  report and `subagent_status` supplies lifecycle summaries, but neither
  independently validates substantive claims, so acceptance-sensitive
  claims require direct inspection or appropriate checks;
  `subagent_status` is only lifecycle summaries, never verified evidence
  or a substitute for the full `subagent_output` result.
- **R7:** No completion claim is made before the required `subagent_output`
  results are collected.
- **R8:** Discovery guidance is on `subagent_list`: consult enabled
  definitions before delegating bounded work with `subagent_call` `new`.
  The list output is the concise set of definitions available for
  delegation.
- **R9:** Each description opens with a purpose sentence followed by the
  sections relevant to that tool's complexity (`subagent_call` longest,
  `subagent_output` medium, `subagent_status`/`subagent_list` concise).
  Literal tool names and `new`/`resume`/`steer` operation literals are
  backticked where they appear.
- **R10:** The existing `session_start`/`input`/`session_shutdown`
  handlers are unchanged.

## Non-Functional Requirements

- **N1:** No new production dependencies; no host modifications.
- **N2:** Completion requires lint, type checking, tests, and build checks to
  pass (constitution Testing).

## Constraints

- **C1:** Guidance names only the four real public tools
  (`subagent_call`, `subagent_output`, `subagent_list`, `subagent_status`)
  and real behavior; unavailable names (Agent/get_subagent_result/task
  tools) are forbidden. Structural inspiration may be taken from
  tintinweb/pi-tasks descriptions, but its domain content and wording are
  not copied.
- **C2:** Tool schemas, parameter shapes, and execution paths stay unchanged;
  only `description` text carries the guidance.

## Non-Goals

- Changing tool schemas, execution behavior, rendering, or config.
- Configurability of the guidance text.
- Any other prompt, runtime, or unrelated change.

## Assumptions

- Pi exposes each active tool's `description` to the model, including under
  custom system prompts, so guidance travels with the tool definition.

## Unresolved Questions

None.
