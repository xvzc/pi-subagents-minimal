# Specification: Context-Based Diagnostics

## Diagnostic Delivery

- **S1:** Production source contains no call to `console.log`, `console.warn`, `console.error`, `console.info`, `console.debug`, or `console.trace`, and no direct write to process stdout or stderr.
- **S2:** A warning with an available `ExtensionContext` is delivered by calling `context.ui.notify(message, "warning")`.
- **S3:** Notification calls are isolated by `try/catch`; synchronous UI errors are swallowed and never fall back to console or stdio.
- **S4:** Existing fixed warning constants and dynamic redacted messages remain the notification payloads.

## Pre-Context Diagnostics

- **S5:** Configuration loading reports diagnostics to an explicit caller-provided sink instead of a global console.
- **S6:** Extension activation collects configuration diagnostics and activation-retention diagnostics before any session context exists.
- **S7:** On `session_start`, the extension delivers the collected activation diagnostics through that context as warning notifications.
- **S8:** Each collected activation diagnostic is delivered at most once for a given `cwd` plus parent-session namespace during one extension activation.
- **S9:** Missing config files remain silent. A successful activation cleanup with no returned warnings remains silent.

## Runtime Diagnostics

- **S10:** Session loading, collision, asynchronous execution, progress persistence, abort, shutdown persistence, completion delivery, terminal cleanup, and retention-result warnings use the affected operation or record context.
- **S11:** Agents-view refresh, disposal, render-request, and render warnings use the view's UI context.
- **S12:** Existing guards and event frequency remain in force, including the one-shot render-request guard and per-event persistence warnings.
- **S13:** When no relevant context/UI is available, the warning is safely dropped without terminal output.

## Compatibility

- **S14:** Public tools, parameters, results, error envelopes, session state transitions, hidden completion signals, storage formats, and cleanup decisions are unchanged.
- **S15:** Agent-definition warnings continue to use context UI notifications and preserve their existing per-namespace behavior.

## Acceptance Criteria

- **A1:** Repository search finds no production `console.*` or direct process stdout/stderr writes under `src/`.
- **A2:** Focused tests verify config and activation diagnostics are deferred and delivered via `ui.notify(..., "warning")`.
- **A3:** Focused tests verify representative session-manager and Agents-view warnings use context UI and notification failures are non-blocking.
- **A4:** Existing warning messages and trigger conditions remain covered.
- **A5:** Format check, lint, typecheck, full tests, and build pass.
