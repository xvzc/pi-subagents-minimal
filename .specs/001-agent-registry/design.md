# Design: Agent Registry

## Overview

The registry is split into metadata validation, filesystem discovery, and precedence/lookup. This keeps raw YAML away from session execution.

## Components

```text
src/agents/
├── metadata.ts
├── loader.ts
└── registry.ts
```

### `metadata.ts`

Parses frontmatter, ignores unknown fields, rejects invalid known fields, validates extension source syntax and the body, and returns `AgentDefinition` or a path-specific diagnostic. Normalized extension source strings remain unresolved until child creation because the project cwd is invocation-specific.

### `loader.ts`

Reads `.md` files from each source directory in lexical order. Filesystem failures become diagnostics rather than extension-wide failures.

### `registry.ts`

Eagerly captures one normalized activation snapshot, combines source layers by precedence, retains disabled overrides, resolves enabled definitions for new sessions, resolves definitions without enabled filtering for retained-session model/thinking metadata, builds sorted list snapshots, and returns defensive copies.

### Activation lifecycle (`src/index.ts`)

The default activation reads the bound registry's captured warning count once and retains a set of notified parent namespaces. Its existing `session_start` handler emits a fixed aggregate `context.ui.notify(..., "warning")` before restoring stored sessions when warnings exist and that namespace has not already been notified. Detailed diagnostics remain owned by `subagent_list`; the lifecycle notification contains no paths or validation messages.

## Decisions

### D1. Strict known-field validation

Unknown metadata fields are silently ignored for forward compatibility. Known fields and the body remain fail-closed because partially accepting `tools`, `model`, or prompts could produce a broader or materially different agent than authored.

### D2. No filename fallback

Identity is explicit in `name`. Renaming a file does not silently rename a public agent.

### D3. Disabled overrides remain authoritative

A project file with `enabled: false` intentionally disables a lower global definition of the same name. Filtering occurs after precedence resolution.

### D4. One immutable snapshot per extension activation

`createAgentRegistry` performs discovery once at construction. `subagent_list`, enabled new-session lookup, and unfiltered retained-session model/thinking lookup share the captured state. Filesystem edits require extension reload/reactivation; `session_start` alone does not rescan. New-session lookup remains enabled-only, while retained-session lookup may use a captured disabled definition. Defensive copies preserve the snapshot against caller mutation.

### D5. Configured extension strings are the public form

Registry summaries copy only normalized `npm:`/`path:` strings. Absolute path resolution is a runtime concern and never replaces the configured list form.

### D6. Aggregate once-per-parent startup notification

A session-start notification is a discovery signal, not a second diagnostic surface. It reports only the captured count and points to `subagent_list`, avoiding path/message injection and oversized notifications. Deduplication uses the same `(cwd, parent session ID)` identity as session storage, so repeated host lifecycle events do not spam while distinct parent sessions still receive notice. The activation snapshot remains immutable and is never rescanned by the notification path.

## Failure Handling

- One invalid file contributes one warning and no definition.
- An unreadable directory contributes a warning and does not block other sources.
- Duplicate names resolve by source precedence; same-directory lexical processing is deterministic and warns on replacement.
- User notification failures are not allowed to alter registry state or trigger a rescan; the host-provided `ui.notify` boundary receives only the fixed aggregate message.
