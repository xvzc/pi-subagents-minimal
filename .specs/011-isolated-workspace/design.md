# Design: Isolated Workspace

## Overview

One optional `subagent_call` field flows through a single validation point in
`SessionManager.call` into the existing child-creation cwd. Parent-rooted
paths are untouched: preparation, store, namespace, and cleanup keep using
`context.cwd`, and resume/steer gain one prohibited-field check each.

```text
src/
├── schemas.ts                    # optional workspaceDir + description
└── runtime/session-manager.ts    # validate, resolve execution cwd, reject on resume/steer

test/
└── workspace-dir.test.ts         # focused schema/execution/rejection coverage
```

## Components

### Public schema

- `SubagentCallSchema` gains `workspaceDir: Type.Optional(Type.String(...))`
  with a description covering isolated-workspace-only execution, parent-root
  retention, omission fallback, and new-only validity.
- No other schema, snapshot, output, or status shape changes.

### New-session validation and routing

`SessionManager.call` for `type: "new"`, after model resolution and before
`allocateSessionId`, calls a small helper:

```ts
private async resolveExecutionCwd(
  workspaceDir: string | undefined,
  parentCwd: string,
): Promise<string>
```

- `undefined` returns `parentCwd` unchanged.
- Non-string, blank-after-trim, or non-absolute values throw the fixed
  `INVALID_ARGUMENT` message.
- Otherwise `stat` checks directory existence; any failure or non-directory
  throws the same fixed message. The supplied path and `stat` error text never
  enter the envelope.
- The resolved cwd is threaded through a new `executionCwd` field on the
  `executeNew` input into `childFactory.create({ ..., cwd: executionCwd })`.
- `prepareExtensions`, `createStore`, `sessionRecordPath`, `namespaceOf`, and
  `cleanup` keep receiving `context.cwd`.

### Resume and steer rejection

- `resume` adds a `workspaceDir !== undefined` check in its prohibited-field
  group (after prompt validation, after the agent check, before `session_id`
  presence/lookup) with message `resume cannot change workspaceDir.`
- `steer` extends its existing prohibited-field condition with
  `workspaceDir !== undefined` and message
  `steer cannot change agent, model, thinking, or workspaceDir.`
- Both reject before any session lookup, state check, or child contact, so an
  unknown ID plus a workspace still reports `INVALID_ARGUMENT`.

## Decisions

### D1. Validate late in the new-call chain, still before allocation

Model resolution errors keep their existing precedence; workspace validation
sits immediately before ID allocation so every invalid value has zero side
effects without reordering unrelated checks.

### D2. No runner change

`createAgentSession` already binds built-in tools and child session cwd to
the creation input, so passing the resolved cwd is sufficient. Preparation
reuse is intentional: extension resources stay parent-rooted.

### D3. Fixed redacted message

One message for all invalid shapes avoids oracle behavior (blank vs missing
vs file are indistinguishable) and leaks no paths.

## Failure Handling

- Invalid workspace values: fixed `INVALID_ARGUMENT`, no allocation, write,
  preparation, or child.
- Resume/steer workspace: `INVALID_ARGUMENT`, no lookup disclosure and no
  mutation.
- Unknown internal `stat` failures are impossible to observe: the helper maps
  every failure to the fixed message.

## Trade-offs

- The parent cwd is not `stat`-checked on omission; that path is the existing
  behavior and stays untouched.
- Resume cannot adopt a workspace even when the retained child has ended;
  callers start a new session instead.
