# Specification: Agent Capability Selection

## Metadata Contract

- **S1:** `tools` and `skills` are optional. Omission normalizes to `[]`. Each field accepts exactly `true` or an array of unique non-empty trimmed strings. `true` means every capability available after resource loading; `[]` means none; a non-empty array means exactly the named capabilities before deny subtraction.
- **S2:** `disallowed_tools` and `disallowed_skills` are optional. Omission normalizes to `[]`. Each field accepts only an array of unique non-empty trimmed strings.
- **S3:** Scalars other than `true`, arrays containing non-strings, blank names, or duplicates invalidate the whole agent file with one fixed field-specific warning. A quoted or bare `*`, `false`, and `null` are not wildcard forms. Lists do not give `*` special meaning.
- **S4:** The normalized `AgentDefinition` always carries all four fields. Allow fields are `true | string[]`; deny fields are `string[]`. Registry snapshots and returned values are defensive copies.

## Resolution

- **S5:** For a new child, selected extensions and Pi skill resources load before named capability validation. Available tools are built-in child tools plus tools registered by selected extensions. Available skills are the skills returned by that isolated child resource loader, including Pi defaults and resources contributed by selected extensions.
- **S6:** An allow value of `true` resolves to the complete available-name set. An allow array resolves to that exact set. The corresponding deny array is then subtracted. Order is stable by the available catalog for `true` and by declaration order for an explicit allow array.
- **S7:** Every explicitly named allow or deny entry must exist in the corresponding available catalog, even when subtraction would otherwise make it ineffective. Any unavailable name fails with `INVALID_ARGUMENT` before session ID allocation or child creation.
- **S8:** Tools are enforced through Pi's session tool controls. Skills are enforced by filtering the resource loader's complete skill view so denied or unselected skills are absent from the system prompt, model-invocable skill list, and skill-command lookup.
- **S9:** `tools: []` and omitted `tools` activate no tools. `skills: []` and omitted `skills` expose no skills. Deny lists alone never grant a capability.
- **S10:** Resume and steer reuse the retained child and do not reload, revalidate, or re-resolve tools, skills, extensions, or agent-file metadata.

## List Contract

- **S11:** Enabled-agent list entries always include `tools`, `disallowed_tools`, `skills`, and `disallowed_skills` in normalized configured form. `true` remains literal `true`; arrays are copied and are not expanded to runtime catalogs.
- **S12:** Human-readable rendering prints `all` for `true`, `(none)` for empty arrays, and comma-separated names for non-empty arrays.

## Compatibility

- **S13:** This feature intentionally replaces the previous omitted-tools host-default behavior and the `tools: *`/`["*"]` wildcard shorthand. Existing agent files must use `tools: true` for all available tools or an explicit list for selected tools.
- **S14:** Existing valid explicit tool arrays, empty arrays, and list-only `disallowed_tools` remain valid with the new defaulting and list-output behavior.

## Errors

- **S15:** Metadata-shape failures produce one path-specific warning with a fixed expectation for the affected field and skip the whole file.
- **S16:** Resource loading/conflict failures retain the existing redacted `EXTENSION_LOAD_FAILED` boundary. Unknown explicit tool or skill names return `INVALID_ARGUMENT` without exposing the unknown value or allocating a session.

## Acceptance Criteria

- **A1:** Parser tests cover omission, `[]`, `true`, explicit lists, trimming, duplicates, blank/non-string entries, `false`, `null`, quoted `*`, and bare YAML `*` for all applicable fields.
- **A2:** Registry/list tests prove normalized defaults, literal `true`, defensive copies, and rendering for all/none/named policies.
- **A3:** Runtime tests prove no tools or skills by default, all capabilities with `true`, exact named selection, deny subtraction, and deny-only non-granting behavior.
- **A4:** Runtime tests prove built-in, ambient, and selected-extension capability catalogs are validated after loading; unknown allow and deny names fail before allocation and cleanup remains owned.
- **A5:** Tests prove filtered skills are absent from both prompt-visible skill resources and skill-command resolution, while allowed skills remain usable.
- **A6:** Resume tests prove retained capability/resource identity is not reloaded or changed.
- **A7:** Formatting, lint, type checking, tests, and build all pass.
