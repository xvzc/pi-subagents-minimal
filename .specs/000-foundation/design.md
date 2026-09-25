# Design: Foundation and Configuration

## Overview

The foundation owns package initialization, public tool registration, common data contracts, stable error serialization, and immutable effective configuration. It exposes interfaces consumed by later features without implementing their behavior.

## Components

```text
src/
├── index.ts                 # four tool definitions with inline descriptions, TOOL_NAMES/ToolName,
│                             exact-order createTools, activation/config/service composition/event wiring
├── config.ts
├── schemas.ts
├── types.ts
└── errors.ts
```

### `index.ts`

Owns the four tool definitions with inline `description` strings
(`createTools` in exactly `call`, `output`, `list`, `status` order),
the `TOOL_NAMES`/`ToolName` surface, the tool-boundary helpers
(`toPayloadText`/`payloadResult`/`errorResult`/`safeExecute`/`unbound`),
the `subagent_call` presentation/render state, service composition,
tool registration, lifecycle event wiring, and the immutable effective
configuration. It exports `createTools`, `TOOL_NAMES`, and `ToolName`
with no description constants.

### `config.ts`

Defines defaults, resolves both paths, validates each field independently, merges global then project values, and returns one immutable configuration object.

### `schemas.ts`

Owns public TypeBox schemas and the seven-value thinking enum. Action-specific runtime validation remains with the owning feature.

### `types.ts`

Owns IDs, run states, snapshots, configuration, and narrow service interfaces. It does not import concrete managers.

### `errors.ts`

Creates stable coded errors and converts unknown internal failures to `INTERNAL_ERROR` without leaking sensitive details.

## Decisions

### D1. Load configuration once

Runtime reload would require deciding which in-flight runs adopt new values. Loading once gives every parent session one coherent configuration.

### D2. Tolerant operational configuration

Each valid field applies independently. This differs from strict agent metadata because a typo in one operational setting should not discard unrelated valid overrides or prevent startup.

### D3. Tool registration before implementation composition

The four-tool public surface is fixed in the foundation. Concrete handlers depend on service interfaces so session and storage features can be implemented and tested separately.

## Failure Handling

- Missing files: no warning.
- Read/parse/root failures: warning and no contribution from that file.
- Invalid/unknown fields: warning per field.
- Tool boundary exceptions: coded error response, never uncaught into Pi.
