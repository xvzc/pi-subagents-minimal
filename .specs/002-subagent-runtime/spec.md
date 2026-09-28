# Specification: Subagent Runtime

## `subagent_call`

Input:

```ts
{
  type: "new" | "resume" | "steer";
  agent?: string;
  model?: string;
  thinking?: ThinkingLevel;
  session_id?: string;
  prompt: string;
}
```

- **S1:** `prompt` is non-empty after trimming; the trimmed value is sent to the child.
- **S2:** `new` and `resume` always execute in background. Both use the shared activation-snapshot agent frontmatter → call → config → current-parent model/thinking resolver before persistence, persist and publish queued, then always return a copy of that queued acceptance snapshot (including the optional S5 warning for `new`) without `started_at`, `output`, `error`, `usage`, or `completed_at`. A later read may already observe running or terminal state. There is no foreground execution and no `async` parameter.

### New

- **S3:** `agent` is required and resolves an enabled exact-name definition through the same bound activation snapshot used by list behavior.
- **S4:** Missing `agent` fails with `INVALID_ARGUMENT`; unknown/disabled fails with `AGENT_NOT_FOUND`. Prompt and agent validation, T1 model/thinking resolution against `ExtensionContext.modelRegistry.getAll()`, concrete-model lookup in that registry, and tool-name validation all precede ID/child allocation.
- **S5:** A supplied `session_id` is ignored, a fresh session is created, and warning `{ code: "SESSION_ID_IGNORED", message: "session_id is ignored when type is \"new\"." }` is returned; `warnings` is otherwise omitted.
- **S6:** `new` and `resume` own the shared execution primitive's task promise, attach rejection handling immediately, clear only the task reference on settlement, and retain snapshot/child state. Independent new sessions may execute concurrently subject only to the 004 FIFO concurrency gate.

### Resume

- **S7:** Resume validates before mutation in this order: trim prompt and reject empty as `INVALID_ARGUMENT`; reject a supplied `agent` as `INVALID_ARGUMENT`; reject missing/blank `session_id` as `INVALID_ARGUMENT`; reject malformed, non-`ses_`, unknown, deleted, or different-parent-namespace session IDs as `SESSION_NOT_FOUND`; apply action state rules; look up the retained agent name in the shared activation snapshot; then resolve model/thinking from captured agent frontmatter, call parameters, effective config, and current parent context. Namespace membership is not disclosed, so registry/resolution errors never precede session visibility and resumability checks.
- **S8:** Queued, running, or synchronously reserved records fail with `SESSION_BUSY`. A terminal record without a live child fails with `SESSION_NOT_RESUMABLE`; a terminal record with its retained live child is resumable. Resume reads only the retained agent name's normalized model/thinking metadata from the activation snapshot; it does not rescan files, reload/re-resolve extensions, tools, system prompt, or conversation, and does not create a child. A name absent from the snapshot contributes no agent layer; a captured disabled definition remains eligible for model/thinking resolution.
- **S9:** A per-record reservation is acquired synchronously before the first await. It remains, with the owned task, through strict terminal persistence/cleanup and releases on every queue failure or settlement path; competing resumes observe `SESSION_BUSY`.
- **S10:** Resume preserves `session_id`, agent, `created_at`, and metadata, while freshly resolved model/thinking become the queued effective values; retained model/thinking are not fallback sources. Its queued snapshot omits prior `started_at`, `completed_at`, output, error, and usage. The order is resolve/compare → persist/publish queued → wait for admission → configure the retained child when either effective value changed → persist fresh running with a fresh `started_at` → prompt → T3 progress/terminal semantics with a fresh `completed_at`. Model is configured before thinking, and a model change always reapplies resolved thinking after Pi's model-switch clamp. Queued-write or pre-admission shutdown leaves child configuration unchanged. Configuration failure disposes and removes the retained child, terminalizes the accepted queued snapshot as `failed` without writing running or prompting, and makes later resume return `SESSION_NOT_RESUMABLE` so uncertain live settings cannot be reused. Running-write or prompt-start failure attempts a terminal failed write.
- **S43:** Resume returns the successfully persisted queued acceptance copy immediately under the same ID, without warnings, `started_at`, terminal/progress fields, or stale turn fields.
- **S44:** `max_turns` resets for every prompt invocation, including resume. Usage may expose newly observed cumulative Pi session statistics, but output/error/abort/limit state is turn-local and no prior assistant output is reused when the resumed prompt observes no assistant message.

### Steer

- **S11:** Steer retains its own validation order: after prompt validation, supplying `agent`, `model`, or `thinking` fails with `INVALID_ARGUMENT` before ID/state lookup. It otherwise applies the same session-ID visibility rules as resume.
- **S12:** Only a published `running` session record with a live child can be steered. Every other known state, including a reloaded terminal record, fails with `SESSION_NOT_RUNNING`; malformed and unknown records remain `SESSION_NOT_FOUND` under S7.
- **S13:** Manager validation and `ChildSessionHandle.steer(trimmedPrompt)` queue insertion occur in one synchronous critical section before yielding. Queue insertion is the linearization point. If settlement wins before validation, steer fails `SESSION_NOT_RUNNING`; if it wins after insertion but before Pi acknowledges, success still returns exactly `{ session_id, status: "running", steered: true }`.
- **S14:** Steer is an immediate control operation, not a foreground execution. A thrown Pi steer error becomes redacted `INTERNAL_ERROR`; successful steer writes no snapshot.

## Model and Thinking Resolution

- **S15:** For both new and resume, model and thinking resolve independently using agent frontmatter captured in the current activation snapshot → call parameter → effective config → current parent context.
- **S16:** Model references are trimmed, then resolved against Pi's full model catalog (not authenticated availability): canonical `provider/modelId`, or a bare model id matching exactly one catalog model. A normalized agent model outranks the call model. When agent model is absent, an omitted call model falls through while a supplied whitespace-only call model is an authoritative zero-match and returns `MODEL_NOT_FOUND`. Other zero or multiple matches — including no model across all four layers — also return `MODEL_NOT_FOUND` before allocation, reservation, persistence, or child mutation. The persisted and returned form is canonical `provider/modelId`.
- **S17:** Supported thinking levels are queried from the resolved concrete model through Pi's official `getSupportedThinkingLevels`.
- **S18:** Agent, call, or config thinking unsupported by the model returns `THINKING_LEVEL_UNSUPPORTED` before child allocation or retained-child mutation. If all four thinking layers are absent, resolution returns `INVALID_ARGUMENT` rather than defaulting to `off`.
- **S19:** Only current-parent-inherited thinking is clamped with Pi's official model-aware `clampThinkingLevel`.
- **S20:** Non-reasoning models may support only `off`; `xhigh` and `max` succeed only when reported by the model.
- **S21:** Resume uses the same S15–S19 policy as new against the current four layers and never uses retained snapshot values as fallback. After fresh resolution, an unchanged effective pair skips reconfiguration; a model change configures the concrete model plus resolved thinking, and a thinking-only change configures only thinking.

## Session State

```text
created -> queued -> running -> completed
                         |----> failed
                         |----> stopped
                         `----> aborted
terminal -> queued/running  (resume with live conversation)
```

- **S22:** At most one active turn exists per session.
- **S23:** One awaited `session_shutdown` handler covers Pi reasons `quit`, `reload`, `new`, `resume`, and `fork` and calls namespace-scoped shutdown. It includes all active child-session records.
- **S24:** Every session has one `ses_` ID.
- **S31:** New-session persistence order is validate/resolve → allocate `ses_${randomUUID()}` → persist queued → create child → persist running immediately before prompt → execute/extract → persist terminal → retention cleanup. In-memory publication follows successful writes. Initial write failure prevents child creation; child creation/prompt failures attempt a terminal failed write.
- **S32:** Terminal-write failure returns `INTERNAL_ERROR`, retains the observed terminal snapshot only in process memory, and skips cleanup. Cleanup failure after a successful terminal write is warn-only.
- **S33:** Tool and skill policy resolution follows `007-agent-capability-selection/S5`–`S10`. Omitted or empty allow policies activate no capabilities, `true` activates every post-load available capability, explicit arrays activate named capabilities, and deny arrays subtract after validation. Any unknown explicit allow or deny name fails `INVALID_ARGUMENT` before allocation.
- **S34:** The agent Markdown body is supplied through public `DefaultResourceLoader` system-prompt behavior. Child extension loading is disabled to prevent recursion while Pi's built-in/default-tool behavior remains intact.
- **S35:** `max_turns` counts `turn_end` assistant/model turns. When the exact limit is reached, no further model request begins and the result settles `stopped` with `{ code: "MAX_TURNS_REACHED", message: "The child session reached its configured maximum number of turns." }`. Omission adds no extension limit.
- **S36:** Terminal snapshots carry the terminal snapshot fields. `output` is the observed last assistant text and may coexist with `error`; unavailable output is omitted. `usage`, when observed through host session stats, contains only `turns` (assistant messages), `tool_uses` (tool calls), and `total_tokens`. `new`/`resume` tool results carry only the queued acceptance; terminal fields are observed via `subagent_output` or the background completion push.
- **S37:** Natural success is `completed`; startup, prompt, or assistant error is `failed`; an unexpected abort is `aborted`; the exact extension turn limit is `stopped`. Provider/auth runtime limitations after catalog resolution are inspectable execution failures, not `MODEL_NOT_FOUND`.
- **S38:** The manager retains one live child conversation handle across prompts. Each prompt installs and detaches a fresh listener, resets invocation-local output/error/abort/limit/turn state, and reinstalls the per-call turn-stop predicate. The handle exposes reconfiguration through public Pi `AgentSession.setModel`/`setThinkingLevel`, `steer(prompt): Promise<void>` through `AgentSession.steer`, and abort/disposal through their public session APIs.
- **S39:** Child creation remains between queued and running writes. Every assistant `turn_end` observes the last assistant text and cumulative session stats and enqueues a serialized running-snapshot refresh. Only successful refreshes publish; one fixed redacted warn-only diagnostic represents each failed refresh. The refresh chain drains before the strict terminal write.
- **S40:** Terminal persistence failure publishes the observed terminal snapshot process-locally, skips retention, and causes the owned task to emit one fixed redacted operational warning without overwriting an observed child error.
- **S41:** After activation retention cleanup, each awaited `session_start` loads `RecordStore.loadSessions` for the current cwd and parent session, replaces that parent namespace in memory, publishes loaded records before resolving, and logs load warnings using only supplied path/message. Persisted active records arrive storage-normalized as aborted.
- **S42:** After a successful terminal write, cleanup is awaited. `CleanupResult.deletedPaths` are mapped through the authoritative session path helper and matching terminal records are evicted immediately. A non-empty `CleanupResult.warnings` emits one aggregate fixed redacted diagnostic per cleanup call; cleanup rejection emits one fixed redacted warning and leaves memory unchanged. Activation cleanup follows the same aggregate result-warning rule and never includes thrown exception text.
- **S45:** Shutdown synchronously closes admission for `namespaceOf(context)` before its first await and memoizes one promise; repeated calls return that same promise. New, resume, and steer against the closed namespace fail before mutation with `INTERNAL_ERROR` and exact message `The parent session is shutting down.` A different namespace remains independent, and loading never reopens a closed namespace.
- **S46:** Each active live record has one shutdown marker and settlement gate. A marker installed before terminal commit wins; an already committed terminal result remains byte/state untouched. Queued-before-child, child-created-before-running, running, resume-reserved, and active-progress-write records all settle safely. A child created after marking writes neither running nor prompt: it is aborted and settled.
- **S47:** `ChildSessionHandle.abort(): Promise<void>` delegates to awaited public `AgentSession.abort()`. Shutdown order is close admission → mark every active record → request every available abort → await/drive owned execution → drain serialized progress → persist aborted → publish aborted → cleanup → clear task/reservation. If abort rejects while the raw host prompt remains pending, a manager-owned settlement signal releases the execution wrapper; the detached prompt retains fulfillment/rejection handlers and late completion/progress cannot publish. Successful abort still awaits orderly prompt/execution settlement. Optional disposal may occur only afterward. All independent record stages use all-settled ownership so one failure cannot skip another record.
- **S48:** Shutdown writes exact error `{ code: "PARENT_SHUTDOWN", message: "The parent session shut down while the child session was active." }`, preserving actually observed output and usage. Once marked, progress may drain but cannot publish over shutdown settlement. Output/status remain readable after closure.
- **S49:** Abort failure emits one fixed redacted warning for that record and still forces aborted settlement. Shutdown-persistence failure retains aborted process-locally, skips cleanup, emits one fixed redacted warning, and does not prevent other records. Cleanup retains S42 warn-only behavior. The lifecycle handler resolves best-effort and never throws into Pi.
- **S50:** Data-only active snapshots loaded through the 003 storage boundary are already restart-normalized to terminal aborted and require no live abort. Terminal loaded or local records are not rewritten by shutdown.
- **S51:** A child failure keeps the public `CHILD_EXECUTION_FAILED` code and the base message `The child assistant turn failed.`; a recognized failure may append a fixed, bounded cause label to that message. A startup, reconfiguration, or prompt-rejection failure likewise keeps its existing code/base message, optionally with a safe cause label. Unrecognized causes retain the exact base message. The error may add one of two exact diagnostics: an assistant `turn_end` with normalized stop reason `error` records `{ phase: "assistant_stop", assistant_turn, stop_reason: "error" }`, where `assistant_turn` is a positive integer; a thrown `AgentSession.prompt()` records `{ phase: "prompt_throw" }`. Assistant-stop evidence wins if the prompt subsequently throws. Retained `subagent_output` exposes the resulting error message.
- **S52:** Cause classification may inspect a bounded portion of provider `errorMessage` on assistant error stops, or a thrown string / `Error.message` and bounded `cause` chain on prompt failures. Only predetermined fixed labels may enter the error message; raw provider/exception text, `rawStopReason`, stacks, prompts, credentials, URLs, and arbitrary exception fields are never persisted as cause details. Inaccessible properties or unrecognized text fall back to the generic message. Provider-specific labels are restricted to assistant-stop evidence; unknown-origin prompt failures may receive only neutral network/timeout labels, and creation, reconfiguration, or storage failures keep generic messages. Cause classification must not change the phase/turn/normalized-stop diagnostic, which retains its exact finite shape.
- **S57:** For an assistant `stopReason: "error"` only, the original string-valued provider `errorMessage` already read at the turn boundary may be retained in volatile process memory for the expanded `subagent_output` renderer. It must be absent from stored snapshots, tool `content`/`details`/JSON, collapsed UI, completion pushes, logs, and status. A rendered output result may display it only while its own process-local result identity still matches the current terminal failed assistant-stop turn; an `aborted` settlement (even after an assistant error stop), resume, replacement/loading, shutdown settlement, or unrelated failures cannot display it. Empty sanitized text adds no UI line. The renderer preserves existing control-character sanitization (including carriage returns) and expanded-body truncation. Pi's HTML `/export` reuses the expanded renderer without an export discriminant: exporting while the message is available can save the raw provider message into HTML despite the otherwise memory-only boundary; this export risk is accepted.
- **S53:** Omitted `extensions` and `extensions: []` load no child extensions. An `npm:` source accepts only an unversioned unscoped or scoped package name. It resolves only an already-installed Pi-managed package, first at `<cwd>/.pi/npm/node_modules`, then at `<agentDir>/npm/node_modules`; a missing package fails without registry access, installation, temporary resolution, or fallback to ordinary project/global `node_modules`. Each `path:<relative>` resolves first against `<cwd>/.pi`, then against `<agentDir>`; the first existing target physically contained by its root wins. For either source kind, an invalid higher-precedence candidate never falls back. A local file must be a regular `.js`/`.ts` file. A selected package's explicit `pi.extensions` uses Pi 0.84.2 source ordering, glob expansion, `!` exclusion, override, and stable path-deduplication behavior. Without an explicit manifest, only Pi package conventions are considered: the package-root `extensions/` convention honors `.gitignore`, `.ignore`, and `.fdignore`, loads direct `.js`/`.ts` entries and one-level child package/index entries, and does not recursively import unrelated package-root or nested scripts. A directly selected extension directory may resolve its `index.ts`/`index.js`. Malformed declarations, lexical/expanded traversal, absolute paths, unsupported final targets, and selected top-level or pattern-matched symlink escapes fail closed.
- **S54:** Child resource loading retains `DefaultResourceLoader({ noExtensions: true })`. For both installed npm packages and local sources, only canonical validated entrypoint files—not package names, package directories, or unvalidated manifest entries—are supplied through `additionalExtensionPaths`. Pi 0.84.2's explicit additional-source path remains active in this mode, while ambient global/project extensions and Pi's temporary npm source resolution are excluded.
- **S55:** Selected extensions load before final tool validation and session ID allocation. Loader errors, unresolved selected sources, and tool conflicts return `EXTENSION_LOAD_FAILED` with `Agent "<agent>" extensions could not be loaded.` at the parent tool boundary. Explicit tools validate against the union of built-in child tools and tools actually registered by the loaded selected extensions; unknown names retain `INVALID_ARGUMENT`. No source path or loader diagnostic is exposed.
- **S56:** Resume and steer retain the existing child and never reload or re-resolve agent files, extensions, or tools; resume reads only captured model/thinking metadata for its retained agent name and resolves the activation/current-call layers under S7/S10/S15–S21. Preparation ownership is registered before asynchronous loading begins. It transfers only after successful child creation; otherwise one idempotent owner disposes it across validation, setup/model, persistence, admission cancellation, creation failure, and shutdown races. Parent namespace shutdown awaits in-flight preparation, disposes untransferred preparation, and disposes every retained live child through public `AgentSession.dispose()` after active settlement.

## `subagent_output`

Input:

```ts
{ session_id: string }
```

Output:

```ts
{
  session_id: string;
  agent: string;
  model: string;
  thinking: ThinkingLevel;
  status: RunStatus;
  output?: string;
  error?: {
    code: string;
    message: string;
    diagnostic?:
      | { phase: "assistant_stop"; assistant_turn: number; stop_reason: "error" }
      | { phase: "prompt_throw" };
  };
  usage?: { turns: number; tool_uses: number; total_tokens: number };
}
```

- **S25:** Reading output returns a fresh projection and never consumes, mutates, reloads, or rewrites the retained record.
- **S26:** Only an existing `ses_` record is accepted. Malformed IDs, unknown/deleted sessions, and non-`ses_` IDs fail with `SESSION_NOT_FOUND`.
- **S27:** Output returns only `session_id`, `agent`, `model`, `thinking`, `status`, and available `output`, `error`, and `usage`; unavailable fields are omitted and timestamps, metadata, and warnings are never exposed. Local and activation-loaded records behave identically.

## Session Portion of `subagent_status`

```ts
{
  active_sessions: Array<{
    session_id: string;
    agent: string;
    status: "queued" | "running";
    started_at: string;
  }>;
  recent_sessions: Array<{
    session_id: string;
    agent: string;
    status: "completed" | "failed" | "stopped" | "aborted";
    completed_at: string;
  }>;
}
```

- **S28:** The session-status source includes all retained sessions and contains summary fields only, never model, thinking, output, error, usage, or metadata.
- **S29:** Active means queued/running and sorts by `started_at ?? created_at` ascending, then `session_id` ascending; its required `started_at` field is that effective start. Recent contains every terminal session with no cap and sorts by `completed_at` descending, then `session_id` ascending.
- **S30:** The T3 public composite delegates to the session-status source and returns the session arrays only.

## Acceptance Criteria

- **A1:** A named agent starts in background and returns a queued acceptance with effective model, thinking, and a `ses_` ID; completion is observed via output/push.
- **A2:** New/resume return before settlement and later output observes progress and completion.
- **A3:** Resume succeeds only for terminal records with live conversations, enforces one active turn, resolves activation-snapshot agent → call → config → current parent after visibility/resumability checks with no retained fallback, applies changed effective settings to the retained child and snapshots, skips unchanged reconfiguration, preserves child/extensions/tools/system prompt/conversation identity, rejects invalid resolution before mutation, and terminalizes post-acceptance child-configuration failure without prompting.
- **A4:** Steer succeeds only for running sessions and returns immediately.
- **A5:** Output is repeatable and status excludes full output.
- **A6:** Model/thinking precedence is activation-snapshot agent frontmatter → call parameter → effective config → current parent for both new and resume; filesystem edits require extension reactivation.
- **A7:** Unsupported agent/call/config thinking fails; current-parent-inherited unsupported thinking clamps; absence across all four thinking layers fails instead of defaulting to `off`.
- **A8:** Every Pi shutdown reason awaits one memoized namespace barrier that closes admission, aborts all active live children through public Pi APIs, drains owned execution/progress, and persists/publishes deterministic `aborted` settlement while preserving terminal records, namespace independence, inspection, and best-effort failure isolation.
- **A9:** Focused tests distinguish the exact assistant-stop and prompt-throw diagnostics, preserve successful execution behavior, and prove provider raw/error text, thrown values, and malformed Unicode cannot enter or alter diagnostics.
- **A10:** Focused fake/local-fixture tests prove path precedence and containment, installed-only npm project-before-user precedence, rejection of versioned npm sources, missing-package failure without fetch/install/temporary resolution, Pi-compatible manifest glob/exclusion ordering and package convention/ignore behavior, exclusion of unrelated scripts, pre-import entrypoint validation with no escaped/excluded factory side effect, no ambient extension loading, real-session capability selection under `007-agent-capability-selection`, fail-closed load/conflict behavior before allocation, explicit preparation ownership across race/failure/shutdown paths, and resume reuse without reload.
- **A11:** Focused tests prove string provider error text appears only in the expanded output UI for the matching current failed assistant-stop turn, with control characters sanitized and empty text omitted; never in collapsed UI, tool payloads, persisted/reloaded failed records, or prompt-throw/aborted/other failures. After failed turn A → resume → failed turn B with the same assistant turn number, A's old result displays neither A nor B; B's new result displays only B.
