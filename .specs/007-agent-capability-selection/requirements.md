# Requirements: Agent Capability Selection

## Goal

Give every subagent an explicit, fail-closed allow/deny policy for tools and skills without relying on YAML wildcard syntax.

## Functional Requirements

- **R1:** `tools` and `skills` default to no capabilities, accept `true` for all available capabilities, and accept a list for an explicit allow-set.
- **R2:** `disallowed_tools` and `disallowed_skills` default to an empty deny-set and accept lists only.
- **R3:** Deny-sets subtract from resolved allow-sets after built-in, ambient, and selected-extension capabilities are discovered.
- **R4:** Invalid metadata rejects the whole agent file with one field-specific warning.
- **R5:** Named capabilities that are unavailable after resource loading fail before session allocation or child creation.
- **R6:** `subagent_list` exposes the normalized configured policies without expanding `true` into environment-dependent names.
- **R7:** Resume and steer retain the capability configuration established when the child was created.

## Non-Functional Requirements

- **N1:** Use Pi 0.84.2 public resource-loader and session APIs only.
- **N2:** Capability validation and filtering must be deterministic and fail closed.
- **N3:** Errors must not expose filesystem paths, loader diagnostics, or untrusted metadata values.

## Constraints

- **C1:** Pi exposes native tool allow/deny controls but no equivalent per-session skill allow/deny option.
- **C2:** Skills must therefore be filtered through the child resource loader before they enter prompts or skill commands.
- **C3:** Existing selected-extension isolation and cleanup ownership must remain intact.

## Non-Goals

- Supporting `"*"`, bare `*`, or `false` as capability-selection syntax.
- Reconfiguring tools or skills when a retained session is resumed.
- Installing or fetching skills or extensions.

## Assumptions

- Skill identity is the normalized name returned by Pi's resource loader.
- A capability present in both an allow-set and deny-set is denied.
