/**
 * Pi extension entry point for pi-subagents-minimal.
 *
 * Activation registers exactly the four public tools (S1). Each handler is an
 * explicit service boundary: the tools depend on the narrow service
 * interfaces in `types.ts`. Normal activation composes the default agent
 * registry and background session runtime; the status runtime
 * arrives with later features. Until a service is composed, its tools fail with a coded
 * envelope instead of faking runtime behavior.
 *
 * Tool definitions carry brief capability summaries; operation, usage,
 * workflow, and verification guidance lives in the parameter schemas.
 */

import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
  getAgentDir,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import {
  createAgentRegistry,
  createRegistryService,
} from "./agents/registry.js";
import {
  type ConfigLoadOptions,
  DEFAULT_CONFIG,
  loadEffectiveConfig,
} from "./config.js";
import { notifyWarning } from "./diagnostics.js";
import { handleGuidelineInjection } from "./guidelines.js";
import {
  type ErrorEnvelope,
  isErrorEnvelope,
  MinimalSubagentsError,
  toErrorEnvelope,
} from "./errors.js";
import { renderAgentList } from "./runtime/agent-list.js";
import {
  agentOutputAgent,
  agentOutputData,
  renderAgentOutput,
  SUBAGENT_CALL_PRESENTATION_KEY,
  sanitizeReasonText,
} from "./runtime/agent-output.js";
import { renderAgentStatus } from "./runtime/agent-status.js";
import { SessionManager } from "./runtime/session-manager.js";
import { CompositeStatusService } from "./runtime/status-service.js";
import {
  SubagentCallSchema,
  SubagentListSchema,
  SubagentOutputSchema,
  SubagentStatusSchema,
} from "./schemas.js";
import {
  type CleanupResult,
  cleanupOnActivation,
  type ProjectRetentionContext,
  RETENTION_CLEANUP_RESULT_WARNING,
} from "./storage/retention.js";
import type { MinimalSubagentsConfig, ToolServices } from "./types.js";
import { isSessionId } from "./types.js";

/** Exactly the four public tools (S1). */
export const TOOL_NAMES = [
  "subagent_call",
  "subagent_output",
  "subagent_list",
  "subagent_status",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Serialize a tool payload to model-facing text. A non-serializable payload throws a coded error, which `safeExecute` converts to an `INTERNAL_ERROR` envelope at the tool boundary. */
function toPayloadText(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") {
    throw new MinimalSubagentsError(
      "INTERNAL_ERROR",
      "Tool result was not serializable.",
    );
  }
  return text;
}

/** Wrap a service payload as a tool result, serializing safely (S4). */
function payloadResult(value: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: toPayloadText(value) }],
    details: value,
  };
}

/** Wrap a failure envelope as a tool result (S4). */
function errorResult(envelope: ErrorEnvelope): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: toPayloadText(envelope) }],
    details: envelope,
  };
}

/**
 * Run a handler without letting failures escape into Pi.
 * Coded errors keep their code; anything else becomes `INTERNAL_ERROR` (S4, S17).
 */
async function safeExecute(
  run: () => Promise<AgentToolResult<unknown>>,
): Promise<AgentToolResult<unknown>> {
  try {
    return await run();
  } catch (err) {
    return errorResult(toErrorEnvelope(err));
  }
}

/** Reject calls to a service that no later feature has composed yet. */
function unbound(service: string, tool: string): never {
  throw new MinimalSubagentsError(
    "INTERNAL_ERROR",
    `${tool} is not available: the ${service} runtime has not been composed yet.`,
  );
}

interface SubagentCallDisplayDetails {
  state: "identified";
  agent: string;
}

interface SubagentCallPresentationDetails {
  agent: string;
}

interface SubagentCallRenderState {
  agent?: string;
  sessionId?: string;
  accepted?: boolean;
  failed?: boolean;
  spinner?: SubagentCallSpinner;
  settledCall?: SubagentCallSpinner;
  isolatedHost?: boolean;
}

/**
 * True when a settled `subagent_call` result is a tool-level failure before
 * queued/steer acceptance (schema/runtime error envelope or host `isError`).
 * A later background child failure never flows through this result, so an
 * accepted queued call stays `❯`.
 */
function isSubagentCallFailure(
  result: AgentToolResult<unknown>,
  contextIsError?: unknown,
): boolean {
  if (contextIsError === true) return true;
  if ((result as { isError?: unknown }).isError === true) return true;
  return isErrorEnvelope(result.details);
}

/** Generic safe label when a call failure carries no usable message or code. */
const AGENT_CALL_GENERIC_FAILURE = "Agent call failed.";

const MAX_CALL_SESSION_ID_CHARS = 64;

/**
 * Observed `session_id` for a successful call heading. Only a genuinely
 * observed namespaced ID is shown; failures, missing IDs, and overlong
 * values show nothing rather than a fabricated or truncated ID.
 */
function subagentCallSessionId(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details))
    return undefined;
  const sessionId = (details as Record<string, unknown>).session_id;
  if (!isSessionId(sessionId)) return undefined;
  const safe = subagentDisplayText(sessionId);
  if (safe.length === 0 || safe.length > MAX_CALL_SESSION_ID_CHARS)
    return undefined;
  return safe;
}

/**
 * Safe one-line call failure reason: the error message when usable, else the
 * error code, else a generic label. Always visible (even collapsed) via the
 * result region; the heading carries only glyph/title/metadata.
 */
function subagentCallFailureReason(details: unknown): string {
  if (isErrorEnvelope(details)) {
    const byMessage = sanitizeReasonText(details.error.message);
    if (byMessage.length > 0) return byMessage;
    const byCode = sanitizeReasonText(details.error.code);
    if (byCode.length > 0) return byCode;
  }
  return AGENT_CALL_GENERIC_FAILURE;
}

interface ActiveSubagentCallSpinner {
  spinner: SubagentCallSpinner;
  states: Set<SubagentCallRenderState>;
}

const SUBAGENT_SPINNER_FRAMES = ["⠐", "⠰", "⠴", "⠶", "⠶", "⠦", "⠖", "⠒", "⠐"];
const SUBAGENT_SPINNER_INTERVAL_MS = 80;
const activeSubagentCallSpinners = new Map<string, ActiveSubagentCallSpinner>();

function subagentCallMetadata(
  theme: Theme,
  agent: string | undefined,
  operation: "new" | "resume" | "steer",
  sessionId?: string,
): string {
  const parts = [
    agent ? subagentDisplayText(agent) : undefined,
    operation,
    sessionId,
  ];
  const metadata = parts.filter((value) => value !== undefined).join(" · ");
  return (
    theme.fg("toolTitle", "Agent Call") + theme.fg("dim", ` · ${metadata}`)
  );
}

function subagentDisplayText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_EXPANDED_OUTPUT_CHARS = 100_000;

function subagentExpandedText(value: string): string {
  const safe = stripTerminalSequences(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .trimEnd();
  if (safe.length <= MAX_EXPANDED_OUTPUT_CHARS) return safe;
  return `${safe.slice(0, MAX_EXPANDED_OUTPUT_CHARS)}\n… (output truncated for display)`;
}

class SubagentCallSpinner extends Container {
  agent?: string;
  sessionId?: string;
  accepted = false;
  failed = false;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private invalidationFailed = false;
  private operation: "new" | "resume" | "steer" = "new";
  private theme?: Theme;
  private requestRender: () => void = () => {};
  private onInvalidateFailure: () => void = () => {};
  private readonly heading = new Text("", 0, 0);
  private readonly prompt = new Text("", 2, 0);

  constructor() {
    super();
    this.addChild(this.heading);
  }

  update(
    agent: string | undefined,
    operation: "new" | "resume" | "steer",
    accepted: boolean,
    theme: Theme,
    invalidate: (() => void) | undefined,
    onInvalidateFailure: () => void,
    expanded = false,
    prompt = "",
    failed = false,
    sessionId?: string,
  ): void {
    this.agent = agent;
    this.operation = operation;
    this.accepted = accepted;
    this.failed = failed;
    this.sessionId = sessionId;
    this.theme = theme;
    this.requestRender = invalidate ?? (() => {});
    this.onInvalidateFailure = onInvalidateFailure;
    this.clear();
    this.addChild(this.heading);
    if (expanded) {
      this.prompt.setText(theme.fg("toolOutput", subagentExpandedText(prompt)));
      this.addChild(this.prompt);
    }
    this.refresh();
    if (accepted) {
      this.stop();
    } else if (!this.invalidationFailed && this.timer === undefined) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SUBAGENT_SPINNER_FRAMES.length;
        this.refresh();
        try {
          this.requestRender();
        } catch {
          this.invalidationFailed = true;
          this.stop();
          this.onInvalidateFailure();
        }
      }, SUBAGENT_SPINNER_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private refresh(): void {
    if (!this.theme) return;
    const marker = this.failed
      ? "x"
      : this.accepted
        ? "❯"
        : SUBAGENT_SPINNER_FRAMES[this.frame];
    const color = this.failed ? "error" : "accent";
    this.heading.setText(
      `${this.theme.fg(color, marker)} ${subagentCallMetadata(this.theme, this.agent, this.operation, this.sessionId)}`,
    );
  }
}

function stopSubagentCallSpinner(context: {
  toolCallId?: string;
  lastComponent?: unknown;
  state?: SubagentCallRenderState;
}): SubagentCallSpinner | undefined {
  const id =
    typeof context.toolCallId === "string" && context.toolCallId.length > 0
      ? context.toolCallId
      : undefined;
  const entry =
    id === undefined ? undefined : activeSubagentCallSpinners.get(id);
  const registered = entry?.spinner;
  const last =
    context.lastComponent instanceof SubagentCallSpinner
      ? context.lastComponent
      : undefined;
  const stored = context.state?.spinner;
  const spinners = new Set([registered, last, stored]);
  for (const spinner of spinners) spinner?.stop();
  for (const [activeId, active] of activeSubagentCallSpinners) {
    if (!spinners.has(active.spinner)) continue;
    activeSubagentCallSpinners.delete(activeId);
    for (const state of active.states) {
      if (spinners.has(state.spinner)) delete state.spinner;
    }
  }
  if (context.state) delete context.state.spinner;
  return last ?? stored ?? registered;
}

function subagentCallPayloadResult(
  value: unknown,
  presentationAgent: string | undefined,
): AgentToolResult<unknown> {
  const result = payloadResult(value);
  if (
    !presentationAgent ||
    agentOutputAgent(value) !== undefined ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return result;
  }
  return {
    ...result,
    details: {
      ...(value as Record<string, unknown>),
      [SUBAGENT_CALL_PRESENTATION_KEY]: {
        agent: presentationAgent,
      } satisfies SubagentCallPresentationDetails,
    },
  };
}

/**
 * Build the four tool definitions, wired to the given services.
 * Missing services leave explicit not-yet-composed boundaries.
 * Order is exactly `call`, `output`, `list`, `status`.
 */
export function createTools(services?: Partial<ToolServices>) {
  const sessions = services?.sessions;
  const registry = services?.registry;
  const status = services?.status;
  return [
    defineTool({
      name: "subagent_call",
      label: "Subagent call",
      description:
        "Start, resume, or steer a subagent session within the current task's authorized scope.",
      parameters: SubagentCallSchema,
      execute: async (_toolCallId, params, signal, onUpdate, context) => {
        let presentationAgent =
          params.type === "new" ? params.agent : undefined;
        const result = await safeExecute(async () => {
          if (!sessions) unbound("session", "subagent_call");
          const operation =
            sessions instanceof SessionManager
              ? sessions.bindOperationSignal(signal, context)
              : undefined;
          const lifecycle = {
            identified: (agent: string) => {
              presentationAgent = agent;
              // new/resume always execute in background and return promptly,
              // so only the immediate steer control operation reports identification.
              if (params.type !== "steer") return;
              onUpdate?.({
                content: [],
                details: {
                  state: "identified",
                  agent,
                } satisfies SubagentCallDisplayDetails,
              });
            },
          };
          const value =
            sessions instanceof SessionManager
              ? await sessions.call(params, context, lifecycle, operation)
              : await sessions.call(params, context, lifecycle);
          return subagentCallPayloadResult(value, presentationAgent);
        });
        if (
          !presentationAgent ||
          agentOutputAgent(result.details) !== undefined
        )
          return result;
        return {
          ...result,
          details: {
            ...(result.details as Record<string, unknown>),
            [SUBAGENT_CALL_PRESENTATION_KEY]: {
              agent: presentationAgent,
            } satisfies SubagentCallPresentationDetails,
          },
        };
      },
      renderCall(_args, theme, context) {
        const state = context.state as SubagentCallRenderState;
        state.agent ??= context.args.agent;
        if (
          context.executionStarted === true &&
          context.lastComponent === undefined
        ) {
          // Replay/export is host-local: never reuse or mutate a live global spinner.
          const replay = new SubagentCallSpinner();
          state.accepted = true;
          state.isolatedHost = true;
          replay.update(
            state.agent,
            context.args.type,
            true,
            theme,
            undefined,
            () => {},
            context.expanded,
            context.args.prompt,
            state.failed === true,
            state.sessionId,
          );
          state.settledCall = replay;
          return replay;
        }
        if (context.isPartial === false) {
          const stopped = stopSubagentCallSpinner({ ...context, state });
          const call =
            state.settledCall ?? stopped ?? new SubagentCallSpinner();
          state.settledCall = call;
          state.accepted = true;
          call.update(
            state.agent,
            context.args.type,
            true,
            theme,
            undefined,
            () => {},
            context.expanded,
            context.args.prompt,
            state.failed === true,
            state.sessionId,
          );
          return call;
        }

        const id =
          typeof context.toolCallId === "string" &&
          context.toolCallId.length > 0
            ? context.toolCallId
            : undefined;
        const entry =
          id === undefined ? undefined : activeSubagentCallSpinners.get(id);
        const registered = entry?.spinner;
        const last =
          context.lastComponent instanceof SubagentCallSpinner
            ? context.lastComponent
            : undefined;
        const stored = state.spinner;
        const existing = last ?? stored ?? registered;
        if (id === undefined) {
          stopSubagentCallSpinner({ ...context, state });
          const marker =
            state.failed === true
              ? theme.fg("error", "x")
              : theme.fg("accent", state.accepted ? "❯" : "⠐");
          return new Text(
            `${marker} ${subagentCallMetadata(theme, state.agent, context.args.type, state.sessionId)}`,
            0,
            0,
          );
        }

        const lastWasReplaced =
          context.lastComponent !== undefined && last === undefined;
        const spinner =
          context.executionStarted !== true && lastWasReplaced
            ? new SubagentCallSpinner()
            : (existing ?? new SubagentCallSpinner());
        for (const stale of new Set([registered, last, stored])) {
          if (stale && stale !== spinner) stale.stop();
        }
        if (registered && registered !== spinner && entry) {
          for (const priorState of entry.states) {
            if (priorState.spinner === registered) delete priorState.spinner;
          }
        }
        state.agent ??= spinner.agent;
        state.sessionId ??= spinner.sessionId;
        state.accepted ??= spinner.accepted;
        state.failed ??= spinner.failed;
        const states =
          registered === spinner && entry
            ? entry.states
            : new Set<SubagentCallRenderState>();
        state.spinner = spinner;
        states.add(state);
        activeSubagentCallSpinners.set(id, { spinner, states });
        spinner.update(
          state.agent,
          context.args.type,
          state.accepted === true,
          theme,
          context.invalidate,
          () => {
            const active = activeSubagentCallSpinners.get(id);
            if (active?.spinner !== spinner) return;
            activeSubagentCallSpinners.delete(id);
            for (const activeState of active.states) {
              if (activeState.spinner === spinner) delete activeState.spinner;
            }
          },
          context.expanded,
          context.args.prompt,
          state.failed === true,
          state.sessionId,
        );
        return spinner;
      },
      renderResult(result, { isPartial }, theme, context) {
        const state = context.state as SubagentCallRenderState;
        const details = result.details as
          Partial<SubagentCallDisplayDetails> | undefined;
        if (isPartial) {
          if (details?.state === "identified" && details.agent) {
            state.agent = details.agent;
            state.accepted = true;
            state.failed = false;
            const active = activeSubagentCallSpinners.get(context.toolCallId);
            if (active) {
              for (const activeState of active.states) {
                activeState.agent = details.agent;
                activeState.accepted = true;
                activeState.failed = false;
              }
              active.spinner.update(
                details.agent,
                context.args.type,
                true,
                theme,
                context.invalidate,
                () => {},
                context.expanded,
                context.args.prompt,
                false,
                active.spinner.sessionId,
              );
            }
          }
          return new Text("", 0, 0);
        }

        const spinner = state.isolatedHost
          ? state.settledCall
          : stopSubagentCallSpinner({ ...context, state });
        const failed = isSubagentCallFailure(
          result,
          (context as { isError?: unknown }).isError,
        );
        const agent =
          agentOutputAgent(result.details) ??
          state.agent ??
          spinner?.agent ??
          context.args.agent;
        state.agent = agent;
        state.accepted = true;
        state.failed = failed;
        // Successful results carry the observed session ID into the heading;
        // failures never show an ID.
        state.sessionId = failed
          ? undefined
          : subagentCallSessionId(result.details);
        if (spinner && state.settledCall !== spinner)
          state.settledCall ??= spinner;
        state.settledCall?.update(
          agent,
          context.args.type,
          true,
          theme,
          undefined,
          () => {},
          context.expanded,
          context.args.prompt,
          failed,
          state.sessionId,
        );
        if (!failed) return new Container();
        // Failure reason is always visible, even when collapsed. Success stays
        // empty; the expanded prompt (if any) renders in the call row above.
        const reason = new Container();
        reason.addChild(
          new Text(
            theme.fg("error", subagentCallFailureReason(result.details)),
            2,
            0,
          ),
        );
        return reason;
      },
    }),
    defineTool({
      name: "subagent_output",
      label: "Subagent output",
      description:
        "Read the observed output of a subagent session after its completion notification has been received. Do not use this tool to wait for or poll a running subagent.",
      parameters: SubagentOutputSchema,
      execute: async (_toolCallId, params) =>
        safeExecute(async () => {
          if (!sessions) unbound("session", "subagent_output");
          return payloadResult(await sessions.output(params));
        }),
      // Hide the default tool-call row; only renderResult (Agent Output) shows.
      renderCall() {
        return new Container();
      },
      renderResult(result, { expanded }, theme) {
        return renderAgentOutput(
          agentOutputData(result.details),
          expanded,
          theme,
          result.details,
          sessions?.providerErrorForOutput?.(result.details),
        );
      },
    }),
    defineTool({
      name: "subagent_list",
      label: "Subagent list",
      description: "List the enabled subagent roles available for delegation.",
      parameters: SubagentListSchema,
      execute: async () =>
        safeExecute(async () => {
          if (!registry) unbound("agent registry", "subagent_list");
          return payloadResult(await registry.list({}));
        }),
      // Hide the default tool-call row; only renderResult (Agent List) shows.
      renderCall() {
        return new Container();
      },
      renderResult(result, { expanded }, theme) {
        return renderAgentList(result.details, expanded, theme);
      },
    }),
    defineTool({
      name: "subagent_status",
      label: "Subagent status",
      description: "Show the status of active and recent subagent sessions.",
      parameters: SubagentStatusSchema,
      execute: async () =>
        safeExecute(async () => {
          if (!status) unbound("status", "subagent_status");
          return payloadResult(await status.status({}));
        }),
      // Hide the default tool-call row; only renderResult (Agent Status) shows.
      renderCall() {
        return new Container();
      },
      renderResult(result, { expanded }, theme) {
        return renderAgentStatus(result.details, expanded, theme);
      },
    }),
  ];
}

export const ACTIVATION_CLEANUP_WARNING =
  "[pi-subagents-minimal] Skipped activation retention cleanup.";

/**
 * Run activation cleanup and return its fixed, aggregate diagnostics (010 S6).
 * A cleanup result with returned warnings yields the aggregate retention
 * diagnostic; a thrown cleanup yields the activation-cleanup diagnostic.
 * Successful cleanup without warnings is silent (S9).
 */
export async function runActivationCleanup(
  context: ProjectRetentionContext,
  cleanup: (
    context: ProjectRetentionContext,
  ) => Promise<CleanupResult> = cleanupOnActivation,
): Promise<string[]> {
  try {
    const result = await cleanup(context);
    return result.warnings.length > 0 ? [RETENTION_CLEANUP_RESULT_WARNING] : [];
  } catch {
    return [ACTIVATION_CLEANUP_WARNING];
  }
}

/**
 * Effective configuration from the most recent activation (S8, D1).
 * Loaded once per activation and frozen; before the first activation it is
 * the built-in defaults. Later features read it via {@link getEffectiveConfig}
 * instead of reloading files.
 */
let effectiveConfig: MinimalSubagentsConfig = DEFAULT_CONFIG;

/** The single immutable effective config loaded during activation. */
export function getEffectiveConfig(): MinimalSubagentsConfig {
  return effectiveConfig;
}

/**
 * Pi extension factory. Registers exactly the four public tools (S1, A1),
 * then runs activation retention cleanup (003 S15).
 * Normal activation composes a default agent registry and background session
 * manager bound to the same `agentDir`/`cwd` path context used for config
 * overrides. An explicitly injected service is honored and never overwritten.
 * The status service defaults to the session-only composite.
 *
 * The factory is async so the host awaits activation cleanup: it expires
 * terminal histories project-wide with the immutable effective config and
 * never fire-and-forgets. Cleanup failures are warn-only and never break
 * activation. The session manager separately invokes post-terminal cleanup
 * only after its terminal snapshot write succeeds.
 */
export default async function (
  pi: ExtensionAPI,
  services?: Partial<ToolServices>,
  configOptions?: ConfigLoadOptions,
): Promise<void> {
  // Activation-scoped diagnostics collected before any session context exists
  // (010 S6); flushed once per parent namespace at `session_start` (S7, S8).
  const pendingDiagnostics: string[] = [];
  effectiveConfig = loadEffectiveConfig({
    ...configOptions,
    onWarning: (message) => pendingDiagnostics.push(message),
  });
  const registryOptions = {
    agentDir: configOptions?.agentDir ?? getAgentDir(),
    cwd: configOptions?.cwd ?? process.cwd(),
  };
  const boundRegistry = createAgentRegistry(registryOptions);
  const agentWarningCount = boundRegistry.snapshot().warnings.length;
  const warnedParentNamespaces = new Set<string>();
  const registry =
    services?.registry ?? createRegistryService(registryOptions, boundRegistry);
  const sessions =
    services?.sessions ??
    new SessionManager({
      config: effectiveConfig,
      registry: boundRegistry,
      agentDir: registryOptions.agentDir,
      pi,
    });
  const status =
    services?.status ??
    (sessions instanceof SessionManager
      ? new CompositeStatusService(sessions)
      : undefined);
  const resolved: Partial<ToolServices> = {
    ...services,
    registry,
    sessions,
    ...(status ? { status } : {}),
  };
  for (const tool of createTools(resolved)) {
    pi.registerTool(tool);
  }
  const activationDiagnostics = await runActivationCleanup({
    agentDir: configOptions?.agentDir ?? getAgentDir(),
    projectPath: configOptions?.cwd ?? process.cwd(),
    config: effectiveConfig,
  });
  pendingDiagnostics.push(...activationDiagnostics);
  if (typeof pi.on === "function") {
    if (effectiveConfig.injectGuidelines) {
      pi.on("before_agent_start", handleGuidelineInjection);
    }
    if (sessions instanceof SessionManager) {
      pi.on("session_start", async (_event, context) => {
        const namespace = `${context.cwd}\0${context.sessionManager.getSessionId()}`;
        if (!warnedParentNamespaces.has(namespace)) {
          warnedParentNamespaces.add(namespace);
          for (const message of pendingDiagnostics) {
            notifyWarning(context.ui, message);
          }
          if (agentWarningCount > 0) {
            notifyWarning(
              context.ui,
              `[pi-subagents-minimal] Agent definition loading warnings: ${agentWarningCount}. Run subagent_list for details.`,
            );
          }
        }
        await sessions.load(context);
      });
      pi.on("input", (event, context) => {
        if (event.source === "interactive" || event.source === "rpc") {
          sessions.onParentInput(context);
        }
      });
    }
    pi.on("session_shutdown", async (_event, context) => {
      await sessions.shutdown(context);
    });
  }
}
