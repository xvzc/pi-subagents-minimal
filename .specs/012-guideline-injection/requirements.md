# Requirements: Configurable Coordination Guideline Injection

## Goal

Make the parent coordination policy available in the parent agent system prompt when the extension is used without an equivalent host-provided section, while allowing users to disable the behavior.

## Functional Requirements

- **R1:** The layered extension configuration exposes `injectGuidelines` as a boolean with built-in default `true`.
- **R2:** When `injectGuidelines` is `true`, the extension makes the current `<agent-coordination>...</agent-coordination>` section from the global `SYSTEM.md` available to the parent agent by appending an embedded copy to the assembled parent system prompt.
- **R3:** When the exact embedded section is already present in the assembled system prompt, the extension does not append a duplicate.
- **R4:** When `injectGuidelines` is `false`, the extension does not modify the assembled system prompt.
- **R5:** Guideline injection affects only the parent host prompt lifecycle; it does not modify child agent system prompts or user prompts.

## Non-Functional Requirements

- **N1:** The implementation adds no runtime filesystem dependency on `SYSTEM.md` and no new production dependency.
- **N2:** Existing tool schemas, tool execution, rendering, session behavior, and diagnostics remain unchanged.
- **N3:** Configuration gating, append behavior, and duplicate suppression have automated coverage.
- **N4:** Completion requires lint, type checking, tests, and build checks to pass.

## Constraints

- **C1:** The guideline text is an embedded source constant copied from the complete current `<agent-coordination>` block, including its opening and closing tags.
- **C2:** Injection uses Pi's `before_agent_start` system-prompt replacement contract.
- **C3:** The handler returns a replacement only when an append is required; disabled and already-present cases leave the prompt unchanged.

## Non-Goals

- Runtime loading or hot reloading of `SYSTEM.md`
- User-configurable guideline text or source path
- Modifying child agent definitions or child prompts
- Removing schema-level tool guidance

## Assumptions

- Pi supplies the fully assembled parent system prompt to `before_agent_start` and chains system-prompt replacements from extensions.

## Unresolved Questions

None.
