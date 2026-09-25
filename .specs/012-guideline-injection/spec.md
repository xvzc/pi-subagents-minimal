# Specification: Configurable Coordination Guideline Injection

Extends `000-foundation` configuration and supersedes only the no-`before_agent_start` restrictions in `006-coordination-prompt` when effective `injectGuidelines` is enabled. Existing schema guidance remains unchanged.

- **S1:** `MinimalSubagentsConfig` contains required boolean `injectGuidelines`; `DEFAULT_CONFIG.injectGuidelines` is `true`.
- **S2:** Global and project JSON config layers accept only boolean values for `injectGuidelines`. Project values override global values field by field. Invalid values warn without exposing the rejected value and retain the lower-precedence value.
- **S3:** The extension exports or otherwise owns one immutable embedded string equal to the complete current `<agent-coordination>...</agent-coordination>` block, including tags and internal Markdown.
- **S4:** When effective `injectGuidelines` is `true`, activation registers a `before_agent_start` handler. If the incoming `event.systemPrompt` does not contain the exact embedded block, the handler returns `systemPrompt` formed as the existing prompt, then a blank-line separator, then the embedded block.
- **S5:** If the existing prompt already contains the exact embedded block, the handler returns no system-prompt replacement.
- **S6:** When effective `injectGuidelines` is `false`, activation does not register the guideline injection handler.
- **S7:** The handler does not alter `event.prompt`, messages, images, child session prompts, tool definitions, or any other runtime state.
- **S8:** Empty existing system prompts append without leading blank lines; non-empty prompts use exactly two newline characters before the block.

## Acceptance Criteria

- **A1:** With no config files, activation registers guideline injection and a prompt lacking the block receives exactly one appended embedded block.
- **A2:** With `injectGuidelines: false`, activation registers no guideline injection handler and prompt content is unchanged.
- **A3:** A prompt already containing the exact embedded block receives no replacement and no duplicate.
- **A4:** Empty and non-empty prompt separator behavior matches S8.
- **A5:** Config tests cover true/false, precedence, invalid fallback, and warning redaction.
- **A6:** Tests establish that only the parent `before_agent_start` system prompt is affected and existing tool/runtime contracts remain intact.
