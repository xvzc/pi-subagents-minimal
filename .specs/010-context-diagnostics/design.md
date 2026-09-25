# Design: Context-Based Diagnostics

## Overview

Replace direct terminal diagnostics with a small host-UI warning adapter. Diagnostics produced before an `ExtensionContext` exists are collected by the extension entry point and flushed from `session_start`; runtime diagnostics use the context already owned by the affected session or view.

## Components

### Warning adapter

A narrow helper accepts an `ExtensionUIContext | undefined` and a message. It calls `ui.notify(message, "warning")` inside `try/catch` and has no console fallback. This centralizes failure isolation without introducing a general logging framework.

### Configuration

`loadEffectiveConfig` receives an optional warning callback in `ConfigLoadOptions`. Validation and parse paths call the callback with the same prefixed, redacted strings currently sent to `console.warn`. Callers that omit the callback remain silent.

### Activation

The extension entry point owns an activation-scoped list of pending diagnostics:

1. collect config warnings through `ConfigLoadOptions.onWarning`;
2. have activation cleanup return or report its fixed aggregate diagnostic instead of printing it;
3. on `session_start`, notify each pending message through `context.ui`;
4. track `cwd\0parentSessionId` so each namespace receives the activation diagnostics once.

Agent-definition warning delivery stays on its existing `context.ui.notify` path and shares the same safe adapter where practical.

### Session manager

Session-manager warnings route through the `ExtensionContext` passed to the operation or retained on the live record. Asynchronous continuations capture that context. Shutdown and abort helpers resolve UI from the affected record. Session loading and cleanup already receive a context. Missing context drops the diagnostic.

### Agents view

`AgentsView` already owns `ExtensionContext["ui"]`. Its catch paths call the warning adapter. Notification failures are swallowed so rendering remains best-effort.

## Decisions

### D1. UI notifications instead of stderr

`context.ui.notify(..., "warning")` is the host-supported user-visible warning surface and does not bypass TUI rendering.

### D2. Explicit sinks instead of global mutable context

Configuration reports through a callback and activation owns its pending list. This preserves explicit ownership and avoids a process-global context registry.

### D3. No console fallback

A failing or absent UI must not reintroduce terminal corruption. Diagnostics are best-effort and may be dropped when the host cannot display them.

### D4. Preserve trigger semantics

This change alters transport, not the underlying warning conditions, text, storage decisions, or execution state.

## Failure Handling

- Synchronous `ui.notify` failures are swallowed.
- A missing UI/context drops the warning.
- Activation diagnostics remain bounded to one activation-scoped list.
- Diagnostic delivery never throws into execution, cleanup, loading, shutdown, or rendering.

## Testing

- Replace console spies with UI notification spies.
- Verify deferred config and activation warnings at `session_start`.
- Verify notification failure isolation.
- Search production source for prohibited output APIs.
- Run format, lint, typecheck, full tests, and build.
