# Design: Subagent Runtime

## Overview

A session manager owns lifecycle policy and delegates child creation and retained-session reconfiguration to an agent runner. New and resume share one current-layer model/thinking resolver.

## Components

```text
src/runtime/
├── invocation-resolver.ts
├── agent-runner.ts
├── session-manager.ts
└── status-service.ts
```

### Invocation Resolver

Inputs combine activation state and per-call state: the precedence-resolved `AgentDefinition` captured by the shared activation registry, call parameters, effective-config slice, current parent model/thinking (`InvocationParentContext`), and Pi's full model catalog. One resolver independently selects model and thinking in agent → call → config → parent order and returns effective values only (`{ model: "provider/modelId", thinking }`). New uses the captured enabled selection lookup; resume first validates visibility/resumability, then looks up the retained name in the same captured snapshot without enabled filtering so disabled metadata may still contribute while an absent name simply removes that layer. Model identity is exact — trimmed canonical `provider/modelId`, or a bare id matching exactly one catalog model — and supported levels plus parent-only clamping come from Pi's official `getSupportedThinkingLevels`/`clampThinkingLevel` (`@earendil-works/pi-ai/compat`). A call-level blank model is authoritative only when agent model is absent. No retained snapshot or built-in thinking fallback exists; missing model returns `MODEL_NOT_FOUND`, missing thinking returns `INVALID_ARGUMENT`, unsupported agent/call/config thinking returns `THINKING_LEVEL_UNSUPPORTED`, and only parent-inherited thinking clamps.

### Agent Runner

`ChildSessionFactory`/`ChildSessionHandle` is the narrow deterministic seam. For a non-empty selected extension list, the production factory resolves an unversioned `npm:` package only from Pi-managed project or user npm roots, in that order; missing packages fail and no npm source string reaches Pi's temporary resolver. Version, range, and tag suffixes are rejected during agent metadata validation. Selected npm and `path:` packages are validated, then public Pi 0.84.2 `DefaultPackageManager.resolveExtensionSources()` expands the host's own glob/exclusion, ordering/deduplication, package convention, and ignore semantics without importing code or installing dependencies. Every enabled result is converted to a canonical contained `.js`/`.ts` entrypoint; unsafe/malformed declarations, expanded traversal, unsupported targets, and symlink escapes are rejected before the loader runs. The factory builds and reloads a `DefaultResourceLoader` with the agent body as `systemPrompt`, `noExtensions: true`, and only canonical entrypoint paths in `additionalExtensionPaths`, rejects loader errors/source omissions/tool conflicts, and returns the loaded resource plus post-load tool and skill catalogs and an idempotent disposer. The manager resolves and validates the `007-agent-capability-selection` allow-minus-deny policies before allocation. The factory then resolves the already-canonical concrete model through the call's `ModelRegistry` and calls public `createAgentSession` with the prepared loader, `SessionManager.inMemory(cwd, { id, parentSession })`, model, thinking, resolved tools, and a resource-loader skill view filtered to the resolved set. Omitted/empty extensions retain the existing isolated loader path.

The retained handle exposes one narrow `configure` operation backed by public `AgentSession.setModel` and `setThinkingLevel`. It awaits a model change first, then reapplies the resolved thinking level because Pi clamps thinking during model switching; thinking-only changes skip model mutation. It installs a fresh subscription and invocation-local counters/flags/output for every prompt. It counts assistant `turn_end` events and reinstalls public `Agent.shouldStopAfterTurn` per invocation so the exact `max_turns` boundary prevents the next provider request and resets on resume. On each assistant `turn_end`, it synchronously captures assistant text observed by that invocation and cumulative session stats through a progress callback. It extracts the final turn-local observation, then detaches its listener without disposing the conversation; a prompt with no new assistant event cannot leak stale output. An error stop captures only the normalized Pi `stopReason` and one-based observed turn. Prompt rejection records only its phase. The runtime never reads `rawStopReason`, provider `errorMessage`, or the thrown value because arbitrary untrusted text cannot be proven free of sensitive content. Assistant-stop evidence takes precedence. `steer` trims and delegates to public `AgentSession.steer`; `abort` delegates to and awaits public `AgentSession.abort()`. The handle also exposes public `AgentSession.dispose()`, which namespace shutdown calls for every retained child after active settlement so extension runtimes and listeners do not outlive the parent.

### Session Manager

Owns pre-allocation validation, `ses_` allocation, snapshot ordering, retained live handles, per-record resume reservations, owned async tasks, output projection, namespace loading, and a session-only status source. It receives the fifth-argument `ExtensionContext` on every call and uses its cwd, parent session ID/model/thinking, `ModelRegistry`, and `getAll()` catalog. A bound activation-captured registry object is shared with the default list service so list/new/resume read the same normalized snapshot without per-call filesystem discovery.

New and resume share one background execution primitive. New writes queued before child creation. Resume verifies session visibility/resumability, reads captured model/thinking metadata for the retained agent name, resolves the activation/current-call layers, compares the effective pair with the prior snapshot, synchronously reserves the eligible record, writes/publishes a clean queued snapshot under the same ID, waits for admission, configures the retained child only when values changed, then writes running immediately before prompt. Both serialize warn-only progress refreshes, drain them before terminal persistence, then await cleanup. Every new/resume owns a handled background task and returns a copied queued acceptance. Successful writes publish copied snapshots. A queued resume failure leaves the prior terminal snapshot intact; a running-write failure attempts strict failed settlement. A terminal-write failure keeps the observed terminal process-locally and skips cleanup; the owned task emits a fixed redacted warning. Reservations/tasks clear only after all settlement paths.

Resume/steer share fixed validation ordering and hide different-parent-namespace records as not found. Steer checks published running state/live child and invokes Pi queue insertion synchronously before its first await; insertion is the linearization point, so later settlement cannot change the returned running acknowledgement. Steer performs no storage write and wraps Pi failures in a redacted `INTERNAL_ERROR`.

`session_start` calls `RecordStore.loadSessions` after activation cleanup and replaces only that cwd/parent namespace. Cleanup deletion paths are compared with paths produced by the authoritative session path helper before terminal memory entries are evicted. A non-empty cleanup warning list emits one fixed aggregate diagnostic rather than interpolating warning values; activation cleanup errors likewise emit a fixed message without exception text.

A namespace-state map synchronously closes admission and memoizes its shutdown promise. Extension preparation registers a pending namespace token before its first await; shutdown awaits those tokens, while a post-load admission recheck prevents a late preparation from allocating after closure. An idempotent preparation owner remains on the pending call or live record until successful child creation transfers ownership. Setup, validation, persistence, canceled admission, creation failure, and shutdown paths dispose untransferred ownership exactly once. Shutdown marks all active records in the outgoing namespace before requesting available child aborts. Per-record execution/progress references let the barrier await child creation, prompt settlement, and serialized refreshes. Each active invocation also owns a deferred shutdown signal raced by its handled prompt-settlement projection. Abort rejection emits the fixed warning and resolves this signal, allowing the manager-owned execution wrapper to settle even if the raw host prompt never does; both raw-prompt fulfillment and rejection remain handled, and late progress is blocked by the marker. Successful abort does not resolve the signal and therefore still waits for orderly host prompt settlement. A child created after marking aborts itself and never writes running or prompt. The marker and terminal-settlement gate linearize races: terminal persistence publishes only if shutdown has not won; shutdown persists/publishes the fixed aborted projection after owned work drains. Independent records settle with `Promise.allSettled`; abort and shutdown-write failures use fixed diagnostics, while successful writes proceed through the existing cleanup path. Shutdown never removes readable session records merely because admission closed.

### Status Service

`SessionManager.sessionStatus()` is the session-only source. `CompositeStatusService` is the public T3 composition seam and returns its active/recent arrays.

### Session Snapshots

The existing 003 schema already represents every T2 field, so no storage migration is needed. Snapshots contain effective model/thinking and observed output/error/usage, never live child objects or precedence-source labels. Child handles live only in the manager's process-local record map.

## Decisions

### D1. Shared current-layer resolution

New and resume use the same agent → call → config → current-parent resolver. One registry snapshot is loaded at extension activation and shared by list/new/resume. After session visibility/resumability checks, resume reads only normalized model/thinking metadata for the retained agent name from that snapshot; retained effective session values are comparison inputs, never fallback sources. File edits require extension reactivation.

### D2. Explicit thinking fails, inheritance clamps

Agent metadata, call parameters, and config express deliberate choices and fail loudly when unsupported. Current-parent inheritance is implicit and may cross to a different child model, so it clamps. Missing thinking across all four layers fails rather than silently defaulting to `off`.

### D3. Process-local live conversations

Snapshots can survive restart through storage, but Pi session objects remain process-local. Reloaded records are inspectable and non-resumable.

### D4. No precedence source fields

Precedence is evaluated for every new and resume call. Persist and expose the resulting effective model/thinking, not internal source labels.

### D5. Direct pi-ai dependency for official thinking helpers

`@earendil-works/pi-ai` is a direct production dependency pinned to the peer coding-agent version, importing only `getSupportedThinkingLevels`/`clampThinkingLevel` from `@earendil-works/pi-ai/compat`. Exact identity matching is reimplemented locally (same semantics as Pi's `findExactModelReferenceMatch`) because that helper is not exported from the installed coding-agent package index and its deep module path is outside the package export map.

### D6. Existing snapshot schema is sufficient

T2 uses the 003 `PersistedSessionSnapshot` unchanged. The required status, effective model/thinking, output, error, usage, and timestamps already validate and persist atomically.

### D7. Tool validation before allocation

Accepted explicit tool names are the public Pi built-in coding/read-only tool set plus tools actually registered by successfully loaded selected extensions. Accepted skill names come from the isolated post-load resource loader. Metadata names outside the corresponding catalog fail before ID allocation. Allow/default/deny resolution follows `007-agent-capability-selection/S5`–`S10`.

### D8. Two-root local extension policy

`path:` sources are syntax-checked during metadata parsing and physically resolved at invocation time. The project `.pi` root precedes the agent directory; lexical and `realpath` containment checks reject traversal and symlink escapes without fallback from an invalid project candidate. The selected manifest is parsed strictly, while Pi's package manager performs structured glob/exclusion expansion and convention/ignore discovery. Exclusions are resolved before import and are never handed to the resource loader. Every enabled result is physically checked against the selected package root and only its canonical file path is passed to Pi. Configured source strings remain the registry/list representation. The security check ends after the final `realpath`/type validation and before `DefaultResourceLoader.reload()` opens/imports that canonical path. A same-owner process can replace the canonical file or one of its path components in that interval (TOCTOU); filesystem ownership/permissions remain the boundary for that race.

### D9. Installed-only npm selection

`npm:` is an installed package identity, not an installation or temporary-resolution request. Metadata accepts only package names without a version delimiter. Runtime resolution searches `<cwd>/.pi/npm/node_modules` before `<agentDir>/npm/node_modules`, applies the same containment and entrypoint validation as `path:` packages, and fails when neither managed root contains the package. Ordinary `node_modules`, legacy global installs, registry access, and temporary package roots are outside this selection contract.

### D10. Queued commit before retained-child reconfiguration

Resume persists and publishes its resolved queued snapshot before changing the live child. Admission and shutdown are checked before reconfiguration, avoiding rollback when queued persistence fails. A post-acceptance configuration failure disposes and removes the retained child, becomes an inspectable failed terminal snapshot without a running write or prompt, and prevents later resume from relying on uncertain live settings.

## Failure Handling

- Prompt, exact enabled agent, T1 model/thinking resolution, concrete registry lookup, extension resolution/loading/conflict checks, and tool names validate before ID allocation.
- Extension loader failures become fixed `EXTENSION_LOAD_FAILED` errors without loader text or resolved paths.
- Assistant-stop and prompt-throw failures retain only phase/turn/stop metadata; untrusted provider and thrown messages are fail-closed omitted while preserving the existing public child-failure code/message.
- Initial persistence failure prevents child creation.
- Child startup and prompt throws settle a stable inspectable `failed` snapshot when terminal persistence succeeds.
- Assistant error, unexpected abort, max-turn stop, and natural completion map to distinct terminal states; observed output may coexist with an error.
- Terminal persistence failure keeps the observed process-local snapshot, skips retention cleanup, and emits one fixed redacted operational warning from the owned background task.
- Retention cleanup runs only after a successful terminal write; returned warnings emit one fixed aggregate diagnostic per call, and rejection emits one fixed redacted warn-only diagnostic.
- Registered provider/auth limitations that surface during public SDK child startup/prompt are execution failures, not model lookup failures.
- Progress refresh failure emits a fixed redacted warning and execution continues; queued/running/terminal lifecycle writes remain strict.
- Activation load warnings use only the store-supplied path and fixed message.
- Successful cleanup evicts only terminal session records whose authoritative paths occur in `CleanupResult.deletedPaths`; cleanup failure emits the fixed diagnostic and leaves memory unchanged.
- Parent shutdown closes only the outgoing cwd/parent namespace and reuses one awaited barrier for repeated lifecycle notifications.
- Shutdown abort failures are fixed/redacted and do not prevent forced aborted persistence; shutdown persistence failures retain process-local aborted state, skip cleanup, and remain fixed/redacted.
- Existing terminal records win before marking and remain untouched; loaded active records have already been normalized by `RecordStore` and have no live abort work.
- Resume activation-snapshot lookup and shared resolution occur after visibility/resumability checks but before reservation or writes. A captured missing name falls through; a captured disabled definition remains eligible. Invalid resolution mutates nothing.
- Resume queue-write failure restores no fields because the prior terminal snapshot was never replaced, does not reconfigure the child, and releases every reservation.
- Retained-child configuration failure after queued acceptance disposes/removes the child, writes a failed terminal snapshot without writing running or prompting, leaves later resume non-resumable, and keeps provider/auth text redacted.
- Running-write and prompt startup failures attempt a strict failed terminal snapshot rather than leaving a false active record.
- Reloaded terminal records have no child: resume returns `SESSION_NOT_RESUMABLE`, while steer follows S12 and returns `SESSION_NOT_RUNNING`.

## Host Limitation

The manager can settle its execution wrapper after `AgentSession.abort()` rejects, but JavaScript cannot forcibly settle or cancel an arbitrary raw host promise. That raw prompt may remain pending indefinitely; it is detached only with fulfillment/rejection handlers retained so it cannot become an unhandled rejection or publish late state. Likewise, a host storage/cleanup promise that never settles cannot be forced without an unsupported timeout. No arbitrary timeout is introduced.
