# Specification: Concise Tool Descriptions and Schema Guidance

Extends `002-subagent-runtime` (S2, S7–S14), `004-async-concurrency`
(S17–S19), and `000-foundation`. Runtime behavior and parameter shapes remain
unchanged.

- **S1:** The four tool definitions remain inline in `src/index.ts`
  (`createTools`, order `call`, `output`, `list`, `status`). Each top-level
  `description` is one short capability sentence only. No usage procedure,
  workflow section, parameter rule, or verification guidance remains there.
- **S2:** `SubagentCallSchema` carries operation-specific usage on the owning
  properties: operation selection and background acceptance on `type`; agent
  discovery on `agent`; override semantics on `model` and `thinking`; target
  selection on `session_id`; and assignment, authority, workspace, and secret
  discipline on `prompt`.
- **S3:** Cross-parameter call guidance lives on `SubagentCallSchema` itself:
  completion retrieval, no repeated polling, prerequisite sufficiency,
  replanning after inadequate prerequisites, safe concurrency, writer
  isolation, and best-effort completion delivery.
- **S4:** `SubagentOutputSchema.session_id` carries retrieval timing,
  non-consuming reads, completion-claim discipline, and the distinction
  between child reports and independently verified evidence. General repeated
  read behavior lives on the output schema.
- **S5:** Because `subagent_list` and `subagent_status` take no parameters,
  their usage guidance lives on their empty object schemas. List guidance
  covers discovery before delegation; status guidance limits it to lifecycle
  summaries and points to `subagent_output` for full results.
- **S6:** Parameter names, required/optional status, accepted values, tool
  order, execution paths, rendering, and configuration are unchanged.
- **S7:** No tool defines `promptGuidelines` or `promptSnippet`; no
  `SUBAGENT_*_DESCRIPTION` or `SUBAGENT_*_GUIDELINES` exports exist; no
  `before_agent_start` handler is registered.

## Acceptance Criteria

- **A1:** Every registered tool has a unique, non-empty, single-line
  capability description shorter than 64 characters.
- **A2:** All prior operational, retrieval, evidence, dependency, concurrency,
  authority, discovery, and lifecycle-limit guidance is represented by the
  relevant property or object schema description rather than a top-level tool
  description.
- **A3:** Public input shapes and runtime behavior remain unchanged, including
  the parameterless shapes of `subagent_list` and `subagent_status`.
- **A4:** No prompt-append metadata, description/guideline constants, or
  activation prompt hook is introduced.
