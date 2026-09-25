# Specification: Agent Registry

## Discovery

- **S1:** Definitions are discovered in increasing precedence:
  1. global Pi agent directory,
  2. `<cwd>/.agents/agents/*.md`,
  3. `<cwd>/.pi/agents/*.md`.
- **S2:** A higher-precedence valid definition replaces a lower-precedence definition with the same case-sensitive name.
- **S3:** No embedded definitions are added; an empty registry is valid.
- **S4:** Discovery order within each directory is lexical by filename for deterministic warnings and conflict handling.
- **S21:** Discovery runs once when the bound registry is constructed during extension activation. `snapshot`, `subagent_list`, enabled new-session lookup, and unfiltered retained-session metadata lookup share that captured normalized state and captured warnings. Repeated operations and `session_start` do not rescan files. A fresh extension activation constructs a fresh registry and observes edits, additions, removals, and repaired warnings. Missing directories remain silent empty layers for the captured activation.
- **S22:** Registry methods return defensive copies; callers cannot mutate captured definitions, nested tools/extensions arrays, or warnings.
- **S23:** On `session_start`, an activation with one or more captured agent-loading warnings calls `context.ui.notify(message, "warning")` once successfully for that `(context.cwd, parent session ID)` namespace. Repeated `session_start` events for the same namespace in the same activation do not notify again after success; a synchronous notification failure remains eligible for retry on a later start. Distinct parent-session namespaces are notified independently.
- **S24:** The notification is silent when the captured warning count is zero. Its message is a fixed aggregate containing only the warning count and an instruction to run `subagent_list` for path-and-reason details; individual warning paths and messages are not included. Session start still restores the parent namespace normally, and no agent-file rescan occurs.

## Strict Metadata

- **S5:** A definition is a Markdown file containing YAML frontmatter and a non-empty Markdown body.
- **S6:** `name` is required, case-sensitive, 1–64 characters, and matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- **S7:** `description` is required, non-empty after trimming, and at most 512 characters.
- **S8:** `model` is optional and, when present, is a non-empty trimmed string.
- **S9:** `thinking` is optional and one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- **S10:** Capability metadata follows `007-agent-capability-selection/S1`–`S4`: `tools` and `skills` normalize omission to `[]` and accept `true` or a unique non-empty string array; `disallowed_tools` and `disallowed_skills` normalize omission to `[]` and accept unique non-empty string arrays only.
- **S19:** `extensions` is optional and is an array of unique normalized source strings. Each source is either a syntactically valid `npm:` package source or `path:` followed by a safe non-empty relative path with no absolute form, empty segment, `.` segment, or `..` segment. Unsupported schemes and malformed, blank, or duplicate entries invalidate the file. Omission and `[]` remain distinct normalized metadata states; both select no extensions.
- **S11:** `max_turns` is optional and is a safe integer from 1 through 10000. Omission adds no extension-defined limit.
- **S12:** `enabled` is optional boolean and defaults to `true`.
- **S13:** Unknown keys are ignored without warnings. Missing required fields, invalid known-field values, missing frontmatter, or an empty body invalidate the whole file.
- **S14:** Invalid files are skipped with path-specific warnings and never partially applied.

## Normalized Contract

```ts
interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: true | string[];
  disallowedTools: string[];
  skills: true | string[];
  disallowedSkills: string[];
  extensions?: string[];
  maxTurns?: number;
  enabled: boolean;
  systemPrompt: string;
  source: "global" | "project";
  sourcePath: string;
}
```

- **S15:** Disabled definitions participate in precedence but are not listed or selectable.
- **S16:** Downstream code receives only `AgentDefinition`, never raw frontmatter.

## `subagent_list`

Input:

```ts
{}
```

Output:

```ts
{
  agents: Array<{
    name: string;
    description: string;
    model?: string;
    thinking?: ThinkingLevel;
    tools: true | string[];
    disallowed_tools: string[];
    skills: true | string[];
    disallowed_skills: string[];
    extensions?: string[];
    max_turns?: number;
    source: "global" | "project";
  }>;
  warnings?: Array<{ path: string; message: string }>;
}
```

- **S17:** Only enabled definitions are returned.
- **S18:** Results are sorted by agent name.
- **S20:** List summaries and rendering preserve `extensions` omission versus `[]`, expose only normalized configured extension source strings, and expose normalized configured capability policies according to `007-agent-capability-selection/S11`–`S12` without runtime expansion.

## Acceptance Criteria

- **A1:** With no files, `subagent_list` returns an empty agents array.
- **A2:** Every strict metadata field normalizes correctly.
- **A3:** Unknown keys are silently ignored, while every invalid known-field, frontmatter, and body class in S13 skips the entire file and emits a path-specific warning.
- **A4:** Project precedence overrides global definitions deterministically.
- **A5:** Disabled higher-precedence definitions prevent lower-precedence definitions of the same name from becoming selectable.
- **A6:** Extension sources normalize fail-closed and preserve omission versus `[]`; capability policies normalize fail-closed and list output/rendering exposes only configured policies and extension source strings.
- **A7:** Repeated list/new/resume lookups in one activation remain stable after backing files change, while a newly constructed activation observes the changes; returned objects cannot mutate the captured state.
- **A8:** A captured invalid-agent warning produces exactly one warning notification for each distinct parent-session namespace, repeated starts of the same namespace are deduplicated, a clean snapshot produces no notification, and `subagent_list` retains the detailed diagnostics.
