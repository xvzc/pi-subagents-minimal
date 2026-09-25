# Requirements: Subagent Runtime

## Goal

Provide a stateful subagent session runtime supporting new, asynchronous, resumed, and steered turns with model-aware invocation precedence and inspectable results.

## Functional Requirements

- **R1:** Callers can start a named configured agent in background and receive a queued acceptance.
- **R2:** Callers can resume a terminal session retained in the current process.
- **R3:** Callers can steer a running session.
- **R4:** Callers can repeatedly inspect a session without consuming its output.
- **R5:** Callers can view active and recently terminal session summaries.
- **R6:** Every Pi parent-session shutdown reason (`quit`, `reload`, `new`, `resume`, and `fork`) closes that parent namespace to new session actions, aborts its active child sessions, and durably settles them as `aborted`.
- **R7:** New and resume resolve model and thinking independently from the same activation/current-call sources in this order: agent frontmatter captured by the activation registry, call parameters, effective config, current parent context.
- **R8:** New-session creation validates the prompt, enabled exact-name agent, model/thinking, and declared tool names before allocating an ID or child.
- **R9:** Every accepted new session is inspectable as an ordered persisted `ses_` snapshot from queued through terminal settlement.
- **R10:** A child uses the configured agent body as its system prompt. Tool and skill allow/deny behavior follows `007-agent-capability-selection`; omitted allow fields activate none, `true` activates all post-load available capabilities, explicit lists are exact before deny subtraction, and `max_turns` is enforced after completed assistant turns.
- **R11:** Terminal snapshots contain only observed output and host usage statistics; startup, assistant, abort, stop-limit, and persistence outcomes remain distinguishable.
- **R12:** New and resume resolution use the per-call Pi extension context, including cwd, parent session/model/thinking, model registry, and its full catalog.
- **R13:** New/resume acceptance returns the persisted queued snapshot while an owned execution continues; progress and terminal state remain repeatedly inspectable.
- **R14:** Session start loads the current cwd and parent-session storage namespace after activation cleanup, replacing that namespace in memory.
- **R15:** Session status reports every retained session as summary-only active/recent arrays with deterministic ordering.
- **R16:** Resume reuses only a retained live child, preserves session/agent identity, ownership, extensions, tools, system prompt, conversation, and metadata, reads only the retained agent's model/thinking from the shared activation snapshot, applies freshly resolved effective settings when changed, resets turn-local lifecycle fields, and durably publishes a fresh queued/running/progress/terminal sequence under the same session ID.
- **R17:** Steer queues a trimmed prompt only into a published running direct session with a live child and acknowledges that insertion without writing a snapshot.
- **R18:** Resume and steer validate prompt, prohibited fields, session ID presence/domain/visibility, and action state in a fixed order before mutation. Resume looks up captured agent metadata and resolves model/thinking only after visibility/resumability checks; other-namespace records are not disclosed.
- **R19:** Child prompt observation, turn limits, error/abort state, and assistant output are invocation-local across repeated prompts; usage may remain host-cumulative when observed.
- **R20:** Shutdown is one awaited, memoized namespace barrier: terminal records remain unchanged, output/status stay readable, and closed namespaces reject new, resume, and steer admission before mutation.
- **R21:** Shutdown races settle through one per-record gate so a shutdown marker installed before terminal commit wins, while an already committed terminal result wins.
- **R22:** Shutdown and retention cleanup remain best-effort across independent child abort, persistence, and cleanup-warning/failure outcomes, with fixed redacted operational diagnostics.
- **R23:** Failed child executions retain enough bounded, non-sensitive runtime evidence to distinguish an assistant error stop from a thrown prompt invocation and identify observable turn/stop/provider details.
- **R24:** A new child may load only its agent's explicitly selected extensions. Local packages support Pi 0.84.2 manifest glob/exclusion and convention/ignore semantics while every final local entrypoint remains contained and canonical before import. The explicit tool allowlist validates against built-in child tools plus tools registered by successfully loaded selected extensions.
- **R25:** An `npm:` extension selection names an unversioned package that must already be installed in Pi-managed storage. The project-managed installation takes precedence over the user-managed installation; absence fails and child loading never installs, fetches, or temporarily resolves a package.

## Non-Functional Requirements

- **N1:** At most one turn runs per session.
- **N2:** Invalid action/state combinations fail before mutating the session.
- **N3:** Model-specific thinking support is determined through Pi APIs.
- **N4:** Session failures must not crash the parent Pi session.
- **N5:** Snapshot writes, in-memory publication, child creation, and retention cleanup occur in a deterministic durability order.
- **N6:** Child sessions use only public Pi 0.84.2 APIs and do not recursively activate this extension.
- **N7:** Async task ownership and serialized progress persistence must not create floating promises or unhandled rejections.
- **N8:** Progress persistence failures and async operational failures emit only fixed redacted diagnostics.
- **N9:** A per-record synchronous reservation makes concurrent resume admission linearizable; steer validation and Pi queue insertion occur without an intervening yield.
- **N10:** Namespace admission closes synchronously before shutdown's first await, and every manager-owned execution wrapper, abort, progress-drain, persistence, and cleanup promise the manager can settle is settled before the lifecycle handler resolves. If abort rejects while the host prompt remains pending, the wrapper must be manager-settled and the detached host promise must retain rejection handling.
- **N11:** Shutdown preserves actually observed output and usage when available and cannot allow a late progress publication to overwrite terminal shutdown state.
- **N12:** Child failure diagnostics never newly retain prompts, assistant content, stack traces, headers, credentials, arbitrary exception objects, or unbounded provider text.
- **N13:** Extension path and local-manifest entrypoint resolution fail closed before Pi imports extension code or allocates a session; ambient global/project extensions remain disabled.
- **N14:** Prepared extension resources have explicit process-local ownership and are disposed exactly once on every path where ownership does not transfer to a successfully created child. Parent shutdown cannot finish while a preparation for its namespace remains in flight.
- **N15:** Extension selection does not accept npm versions, ranges, or tags and does not search ordinary project or global npm installation roots.

## Constraints

- **C1:** New/resume model precedence is activation-snapshot agent frontmatter → call parameter → config `defaultModel` → current parent model. A higher layer wins independently of thinking. A supplied call model is authoritative only when agent frontmatter has no normalized model; whitespace-only input then fails with `MODEL_NOT_FOUND` rather than falling through. References resolve against the full Pi model catalog, not authenticated availability, as canonical `provider/modelId` or a bare id matching exactly one catalog model; anything else — including no model across all four layers — fails with `MODEL_NOT_FOUND`.
- **C2:** New/resume thinking precedence is activation-snapshot agent frontmatter → call parameter → config `defaultThinking` → current parent effective thinking. No retained or built-in `off` fallback exists; absence across all four layers fails with `INVALID_ARGUMENT`.
- **C3:** Unsupported agent/call/config thinking fails; only current-parent-inherited thinking clamps.
- **C4:** `resume` cannot change agent by parameter, but after visibility/resumability checks it reads the retained agent name's normalized definition from the activation snapshot shared with list/new. A name absent from that snapshot contributes no agent layer; a captured disabled definition still contributes model/thinking. Retained snapshot values are not a fallback. `steer` cannot change agent, model, or thinking.
- **C5:** Restart-safe inspection is supplied by `003-record-storage`; restart-safe resume is not required.
- **C6:** T3 implements asynchronous `new`, output inspection, activation loading, progress persistence, and session-only status. T4 implements process-local resume/steer; shutdown remains assigned to T5.
- **C7:** A terminal persistence failure is an `INTERNAL_ERROR`: the observed terminal state remains process-local, durable success is not claimed, and retention cleanup does not run. An accepted async execution instead retains/publishes that state and emits one fixed operational warning from its owned task.
- **C8:** T3–T4 add no global session concurrency limit and no storage migration or dependency.
- **C9:** `max_turns` resets for every child prompt invocation, including resume, rather than applying to the conversation lifetime.
- **C10:** Closed-namespace admission uses public `INTERNAL_ERROR` with message `The parent session is shutting down.`; no new public error code is introduced.
- **C11:** Shutdown settlement stores `{ code: "PARENT_SHUTDOWN", message: "The parent session shut down while the child session was active." }`. Child cancellation uses awaited public `AgentSession.abort()`; disposal, if used, occurs only after settlement and never substitutes for abort.

## Non-Goals

- Multiple simultaneous turns in one session
- Resume across process restart
- Session cancellation tool
- Built-in named agents
- UI widgets or conversation viewer

## Assumptions

- Agent resolution is supplied by `001-agent-registry`.
- Record snapshots are supplied by the `003-record-storage` boundary.

## Unresolved Questions

None.
