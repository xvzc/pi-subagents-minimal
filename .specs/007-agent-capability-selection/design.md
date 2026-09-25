# Design: Agent Capability Selection

## Overview

Normalize capability metadata at the agent-file boundary, resolve allow-minus-deny policies after the isolated child resource loader has loaded selected extensions and skills, and pass only resolved capabilities into child creation.

## Components

### Metadata and Types

- Replace the `tools: *` YAML rewrite with strict YAML parsing.
- Parse `tools` and `skills` through one shared allow-policy helper returning `true | string[]` and default omitted fields to `[]`.
- Parse both deny fields through one shared list helper and default omissions to `[]`.
- Extend `AgentDefinition`, registry snapshots, summaries, and list entries with normalized capability fields and defensive copying.

### Resource Preparation

- Extend child preparation to expose the post-load tool-name and skill-name catalogs.
- Keep `DefaultResourceLoader` as the single source of skill discovery, including selected-extension resource contributions.
- Apply a resource-loader skill override/filter before session creation so the child receives only resolved skills. Filtering the loader view, rather than only formatting the system prompt, also governs skill command lookup.
- Preserve current extension runtime invalidation and idempotent preparation disposal.

### Runtime Resolution

- Resolve each allow policy against its catalog, validate every explicit allow and deny name, then subtract denies.
- Perform resolution before session ID allocation and child creation.
- Forward resolved tools through Pi's existing tool controls and resolved skills through the prepared resource loader.
- Resume and steer retain the existing child and do not revisit capability policy.

### Public Listing

- Return normalized configured policies rather than runtime-expanded names.
- Render `true` as `all`, empty arrays as `(none)`, and named arrays as comma-separated values.

## Decisions

### D1. Boolean wildcard

`true` is the only all-capabilities marker. YAML aliases and `"*"` are not supported capability syntax.

### D2. Fail-closed defaults

Omitted allow fields normalize to empty arrays. This is intentionally safer than inheriting host defaults.

### D3. Strict deny validation

Deny entries must name available capabilities even when the allow policy grants none. This catches stale or misspelled policy instead of silently ignoring it.

### D4. Skill filtering boundary

Because Pi 0.84.2 has no per-session skill allow/deny setting, filter the resource loader's skill collection. Do not fork or patch host internals.

## Trade-offs

- The tool default and wildcard syntax are intentionally breaking changes.
- Loading the skill catalog before validation adds preparation work even for `skills: []`, but keeps selected-extension behavior deterministic and supports strict deny validation.
- Strict unknown-deny rejection is less permissive but prevents policy drift.
