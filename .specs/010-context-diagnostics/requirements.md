# Requirements: Context-Based Diagnostics

## Goal

Prevent extension diagnostics from writing directly to the interactive terminal and disrupting the Pi editor by routing user-visible warnings through the Pi UI context.

## Functional Requirements

- **R1:** Every production warning currently emitted through `console.warn` is delivered through the relevant Pi `ExtensionContext.ui` as a warning notification.
- **R2:** Configuration and activation diagnostics produced before an `ExtensionContext` exists are retained and delivered when a session context becomes available.
- **R3:** Runtime, persistence, cleanup, completion, and Agents-view warnings use the context associated with the affected parent session or view.
- **R4:** Warning conditions and fixed redacted message contracts remain unchanged unless context delivery requires deferred emission.
- **R5:** A UI notification failure never changes session execution, persistence, cleanup, shutdown, rendering, or activation outcomes.

## Non-Functional Requirements

- **N1:** Production source writes no diagnostics through `console.*`, `process.stdout`, or `process.stderr`.
- **N2:** Diagnostics remain secret-safe and do not add record contents, invalid values, parser details, or child output to notifications.
- **N3:** Deferred activation diagnostics are bounded to the diagnostics produced by the current activation and are delivered at most once per parent namespace.
- **N4:** The change adds no production dependency and does not alter public tool schemas or result contracts.
- **N5:** Context routing, deferral, failure isolation, and the absence of raw console/stdout/stderr output have automated coverage.

## Constraints

- **C1:** Use the host `context.ui.notify(message, "warning")` API for user-visible warnings.
- **C2:** Preserve existing warning trigger frequency for runtime events; do not introduce broad suppression or throttling beyond existing one-shot guards.
- **C3:** Missing UI context or a throwing UI implementation is handled silently without a console fallback.
- **C4:** Existing unrelated workspace content and behavior remain unchanged.

## Non-Goals

- Changing retention or migration policy.
- Redesigning warning text or exposing per-record retention details.
- Adding persistent log files, telemetry, or a general logging framework.
- Changing hidden subagent completion signals or tool error envelopes.

## Assumptions

- Every interactive, RPC, and print session supplies the host `ExtensionUIContext` defined by the Pi extension API.
- Activation may complete before the first `session_start` event provides an `ExtensionContext`.
