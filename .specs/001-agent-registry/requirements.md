# Requirements: Agent Registry

## Goal

Discover user-defined agents from Pi-compatible Markdown locations and normalize each valid file into one strict `AgentDefinition` consumed by session execution.

## Functional Requirements

- **R1:** `subagent_list` must return all enabled valid agent definitions available to the project.
- **R2:** Global, shared-project, and Pi-project agent directories must be supported with deterministic precedence.
- **R3:** Invalid files must not block unrelated valid agents.
- **R4:** Session code must consume normalized definitions rather than raw YAML.
- **R5:** Agent definitions may select an explicit, normalized list of child extensions without enabling ambient extension discovery.
- **R6:** One normalized registry snapshot is loaded per extension activation and shared by list, new-session selection, and retained-session model/thinking lookup until reactivation.
- **R7:** When that activation snapshot contains agent-loading warnings, starting a parent session must show one user-visible warning for that parent-session namespace and direct the user to `subagent_list` for details.

## Non-Functional Requirements

- **N1:** Known agent metadata fields and the Markdown body are fail-closed per file because partial interpretation could widen tools or select unintended models; unknown metadata fields are ignored.
- **N2:** Warnings must identify the source path and validation reason.
- **N3:** Discovery must be deterministic.
- **N4:** Repeated operations within one activation must not reread agent files or expose mutable references into the captured snapshot.
- **N5:** The session-start notification must use a fixed aggregate message and warning count; it must not include warning paths, validation details, file contents, metadata values, or terminal control sequences.

## Constraints

- **C1:** The extension provides no embedded named agents.
- **C2:** Required metadata: `name`, `description`.
- **C3:** Optional metadata: `model`, `thinking`, `tools`, `extensions`, `max_turns`, `enabled`.
- **C4:** The Markdown body is a required non-empty system prompt.
- **C5:** Unknown metadata fields are ignored without warnings.

## Non-Goals

- Agent creation UI
- Filename fallback for `name`
- Agent memory, skills, nested delegation, or worktree settings
- Model availability validation during discovery
- Live agent-file refresh without extension reactivation
- Replacing the detailed path-and-reason diagnostics returned by `subagent_list`

## Assumptions

- Model and thinking compatibility are validated when a session is created, because the effective invocation may override metadata.

## Unresolved Questions

None.
