# Requirements: Foundation and Configuration

## Goal

Establish a small, typed Pi extension foundation with shared run contracts, stable errors, and layered configuration used consistently by all later features.

## Functional Requirements

- **R1:** The package must load as a Pi TypeScript extension.
- **R2:** The extension must register exactly four public tools: `subagent_call`, `subagent_output`, `subagent_list`, and `subagent_status`.
- **R3:** Shared contracts must namespace session IDs (`ses_`).
- **R4:** Users must be able to configure retention, default model, and default thinking through global and project JSON files.
- **R5:** Project configuration must override global configuration field by field.

## Non-Functional Requirements

- **N1:** Invalid configuration must not prevent extension activation.
- **N2:** Stable public errors must contain a code and human-readable message.
- **N3:** Shared types must not depend on session or storage implementation details.
- **N4:** Defaults and validation rules must have automated tests.

## Constraints

- **C1:** Global config: `<agent-dir>/extensions/pi-subagents-minimal.json`, normally `~/.config/pi/agent/extensions/pi-subagents-minimal.json`.
- **C2:** Project config: `<cwd>/.pi/pi-subagents-minimal.json`.
- **C3:** The built-in default is retention `7` days.
- **C4:** `defaultModel` and `defaultThinking` are optional and have no built-in value.
- **C5:** Supported thinking names are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Non-Goals

- Runtime configuration reload
- Settings UI
- Agent discovery or execution
- Record persistence implementation

## Assumptions

- The Pi host supplies the agent directory, current working directory, parent model, and parent thinking level.

## Unresolved Questions

None.
