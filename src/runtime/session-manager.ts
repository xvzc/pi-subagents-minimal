import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { notifyWarning } from "../diagnostics.js";
import type { AgentRegistryOptions } from "../agents/registry.js";
import { createAgentRegistry } from "../agents/registry.js";
import { MinimalSubagentsError } from "../errors.js";
import type { SubagentCallParams, SubagentOutputParams } from "../schemas.js";
import { sessionRecordPath } from "../storage/paths.js";
import { type LoadResult, RecordStore } from "../storage/record-store.js";
import {
  type CleanupResult,
  cleanupAfterTerminalSettlement,
  RETENTION_CLEANUP_RESULT_WARNING,
} from "../storage/retention.js";
import type {
  PersistedSessionSnapshot,
  StoredError,
} from "../storage/schemas.js";
import {
  createSessionId,
  isSessionId,
  isTerminalStatus,
  type MinimalSubagentsConfig,
  type SessionCallLifecycle,
  type SessionId,
  type SessionService,
  type SessionSummary,
} from "../types.js";
import {
  type ChildExecutionObservation,
  type ChildExtensionPreparation,
  type ChildSessionFactory,
  type ChildSessionHandle,
  createPiChildSessionFactory,
} from "./agent-runner.js";
import {
  AgentsView,
  type AgentViewRow,
  deriveLabel,
  derivePhase,
} from "./agents-view.js";
import {
  ASYNC_PUSH_WARNING,
  type AsyncCompletionNotifier,
  createHostNotifier,
} from "./completion-notify.js";
import { resolveInvocationModelThinking } from "./invocation-resolver.js";

export const MAX_TURNS_ERROR: StoredError = Object.freeze({
  code: "MAX_TURNS_REACHED",
  message: "The child session reached its configured maximum number of turns.",
});

export const PROGRESS_WRITE_WARNING =
  "[pi-subagents-minimal] Skipped a subagent progress snapshot persistence refresh.";
export const ASYNC_EXECUTION_WARNING =
  "[pi-subagents-minimal] An asynchronous subagent execution did not persist normally.";
export const SHUTDOWN_ABORT_WARNING =
  "[pi-subagents-minimal] A child session could not be aborted cleanly during parent shutdown.";
export const SHUTDOWN_PERSISTENCE_WARNING =
  "[pi-subagents-minimal] An aborted child session could not be persisted during parent shutdown.";
export const TERMINAL_CLEANUP_WARNING =
  "[pi-subagents-minimal] Skipped terminal retention cleanup.";
export const LOAD_SESSION_ID_COLLISION_WARNING =
  "Skipped loaded session record because its ID is already owned or reserved in this process.";

export const PARENT_SHUTDOWN_ERROR: StoredError = Object.freeze({
  code: "PARENT_SHUTDOWN",
  message: "The parent session shut down while the child session was active.",
});

const CHILD_START_ERROR: StoredError = Object.freeze({
  code: "CHILD_EXECUTION_FAILED",
  message: "The child session could not be executed.",
});

export interface SessionRecordStore {
  writeSession(snapshot: PersistedSessionSnapshot): Promise<void>;
  loadSessions?(): Promise<LoadResult<PersistedSessionSnapshot>>;
}

export interface SessionManagerOptions {
  config: MinimalSubagentsConfig;
  registry?: ReturnType<typeof createAgentRegistry>;
  registryOptions?: AgentRegistryOptions;
  childFactory?: ChildSessionFactory;
  createStore?: (context: ExtensionContext) => SessionRecordStore;
  cleanup?: (context: ExtensionContext) => Promise<CleanupResult | unknown>;
  now?: () => string;
  createId?: () => string;
  pi?: Pick<ExtensionAPI, "sendMessage">;
  notifier?: AsyncCompletionNotifier;
  agentDir: string;
}

export interface SessionCallResult extends PersistedSessionSnapshot {
  warnings?: Array<{ code: "SESSION_ID_IGNORED"; message: string }>;
}

export interface SessionSteerResult {
  session_id: string;
  status: "running";
  steered: true;
}

export interface SessionStatusResult {
  active_sessions: SessionSummary[];
  recent_sessions: SessionSummary[];
}

export interface SessionStatusSource {
  sessionStatus(): SessionStatusResult;
}

class ExtensionPreparationOwner {
  private state: "owned" | "transferred" | "disposed" = "owned";

  constructor(readonly preparation: ChildExtensionPreparation) {}

  transfer(): void {
    if (this.state === "owned") this.state = "transferred";
  }

  dispose(): void {
    if (this.state !== "owned") return;
    this.state = "disposed";
    try {
      this.preparation.dispose();
    } catch {
      // Resource disposal is best-effort and must not replace the owning error.
    }
  }
}

interface LiveRecord {
  snapshot: PersistedSessionSnapshot;
  namespace: string;
  path: string;
  child?: ChildSessionHandle;
  extensionPreparation?: ExtensionPreparationOwner;
  task?: Promise<unknown>;
  execution?: Promise<PersistedSessionSnapshot>;
  progress?: Promise<void>;
  persistence?: Promise<void>;
  creation?: Promise<unknown>;
  abortSettlement?: Promise<void>;
  reserved?: boolean;
  shutdownMarked?: boolean;
  operationAborted?: boolean;
  abortRequest?: Promise<void>;
  shutdownSignal?: Promise<void>;
  forceShutdownSettlement?: () => void;
  settlement?: "terminal" | "shutdown";
  settlementClaim?: "natural" | "operation" | "shutdown";
  activeSnapshot?: PersistedSessionSnapshot;
  observation?: ChildExecutionObservation;
  store?: SessionRecordStore;
  context?: ExtensionContext;
  published?: boolean;
  taskLabel?: string;
  pushed?: boolean;
  readyForAdmission?: boolean;
  admissionResolve?: (admitted: boolean) => void;
  admission?: Promise<boolean>;
  holdsSlot?: boolean;
  widgetVisible?: boolean;
}

interface LoadBaselineRecord {
  record: LiveRecord;
  state: ReadonlyMap<string, unknown>;
}

interface NamespaceState {
  closed: boolean;
  shutdown?: Promise<void>;
  pendingPreparations: Set<Promise<void>>;
}

interface OperationAbortBinding {
  namespaces: Set<string>;
  aborted: boolean;
  onAbort: () => void;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function captureLiveRecordState(
  record: LiveRecord,
): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(record));
}

function liveRecordStateMatches(
  record: LiveRecord,
  state: ReadonlyMap<string, unknown>,
): boolean {
  const entries = Object.entries(record);
  return (
    entries.length === state.size &&
    entries.every(([key, value]) => state.has(key) && state.get(key) === value)
  );
}

function ownsLiveSession(record: LiveRecord): boolean {
  return (
    record.child !== undefined ||
    record.execution !== undefined ||
    record.task !== undefined ||
    record.creation !== undefined ||
    record.extensionPreparation !== undefined ||
    record.reserved === true ||
    record.holdsSlot === true
  );
}

function warning(suppliedSessionId: string | undefined) {
  return suppliedSessionId === undefined
    ? {}
    : {
        warnings: [
          {
            code: "SESSION_ID_IGNORED" as const,
            message: 'session_id is ignored when type is "new".',
          },
        ],
      };
}

function failedSnapshot(
  snapshot: PersistedSessionSnapshot,
  completedAt: string,
): PersistedSessionSnapshot {
  return {
    ...snapshot,
    status: "failed",
    completed_at: completedAt,
    error: { ...CHILD_START_ERROR },
  };
}

function terminalSnapshot(
  running: PersistedSessionSnapshot,
  observation: ChildExecutionObservation,
  completedAt: string,
): PersistedSessionSnapshot {
  const common = {
    ...running,
    completed_at: completedAt,
    ...(observation.output !== undefined ? { output: observation.output } : {}),
    ...(observation.usage !== undefined ? { usage: observation.usage } : {}),
  };
  if (observation.aborted) {
    return {
      ...common,
      status: "aborted",
      error: observation.error ?? {
        code: "CHILD_ABORTED",
        message: "The child session was aborted unexpectedly.",
      },
    };
  }
  if (observation.error !== undefined) {
    return { ...common, status: "failed", error: observation.error };
  }
  if (observation.maxTurnsReached) {
    return { ...common, status: "stopped", error: { ...MAX_TURNS_ERROR } };
  }
  return { ...common, status: "completed" };
}

function resolveCapabilities(
  allow: true | string[],
  deny: string[],
  availableNames: readonly string[],
): string[] | undefined {
  const available = new Set(availableNames);
  const explicit = allow === true ? [] : allow;
  if (
    explicit.some((name) => !available.has(name)) ||
    deny.some((name) => !available.has(name))
  ) {
    return undefined;
  }
  const denied = new Set(deny);
  const selected = allow === true ? availableNames : allow;
  return selected.filter((name) => !denied.has(name));
}

function namespaceOf(context: ExtensionContext): string {
  return `${context.cwd}\0${context.sessionManager.getSessionId()}`;
}

function createShutdownSignal(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Owns direct session lifecycle, inspection, and session-only status. */
export class SessionManager implements SessionService, SessionStatusSource {
  private readonly records = new Map<string, LiveRecord>();
  private readonly sessionIdReservations = new Map<string, string>();
  private readonly namespaces = new Map<string, NamespaceState>();
  private readonly registry: ReturnType<typeof createAgentRegistry>;
  private readonly childFactory: ChildSessionFactory;
  private readonly createStore: (
    context: ExtensionContext,
  ) => SessionRecordStore;
  private readonly cleanup: (
    context: ExtensionContext,
  ) => Promise<CleanupResult | unknown>;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly maxConcurrent: number;
  private runningSlots = 0;
  private readonly waiters: LiveRecord[] = [];
  private readonly views = new Map<string, AgentsView>();
  private readonly operationAbortBindings = new WeakMap<
    AbortSignal,
    OperationAbortBinding
  >();

  constructor(private readonly options: SessionManagerOptions) {
    this.registry =
      options.registry ?? createAgentRegistry(options.registryOptions);
    this.childFactory = options.childFactory ?? createPiChildSessionFactory();
    this.createStore =
      options.createStore ??
      ((context) =>
        new RecordStore({
          agentDir: options.agentDir,
          projectPath: context.cwd,
          parentSessionId: context.sessionManager.getSessionId(),
        }));
    this.cleanup =
      options.cleanup ??
      ((context) =>
        cleanupAfterTerminalSettlement({
          agentDir: options.agentDir,
          projectPath: context.cwd,
          config: options.config,
        }));
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? createSessionId;
    this.maxConcurrent = options.config.maxConcurrentSubagents ?? 8;
  }

  async call(
    params: SubagentCallParams,
    context?: ExtensionContext,
    lifecycle?: SessionCallLifecycle,
    operation?: OperationAbortBinding,
  ): Promise<SessionCallResult> {
    if (!context) {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "The Pi call context is unavailable.",
      );
    }
    this.assertOperationActive(operation);
    this.assertNamespaceOpen(context);
    if (params.type === "resume") {
      return this.resume(params, context, lifecycle, operation);
    }
    if (params.type === "steer") {
      return this.steer(
        params,
        context,
        lifecycle,
      ) as unknown as Promise<SessionCallResult>;
    }
    const prompt = params.prompt.trim();
    if (prompt === "") {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "prompt must be non-empty.",
      );
    }
    if (params.agent === undefined || params.agent.trim() === "") {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        'agent is required for type "new".',
      );
    }
    const agent = this.registry.findForSession(params.agent);
    if (!agent) {
      throw new MinimalSubagentsError(
        "AGENT_NOT_FOUND",
        `Enabled agent "${params.agent}" was not found.`,
      );
    }

    const catalog = context.modelRegistry.getAll();
    const resolved = resolveInvocationModelThinking({
      invocationModel: params.model,
      invocationThinking: params.thinking,
      agent,
      config: this.options.config,
      parent: {
        ...(context.model ? { model: context.model } : {}),
        ...(context.thinkingLevel !== undefined
          ? { thinking: context.thinkingLevel }
          : {}),
      },
      catalog,
    });
    const [provider, ...modelParts] = resolved.model.split("/");
    const concrete = context.modelRegistry.find(
      provider!,
      modelParts.join("/"),
    );
    if (!concrete) {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "The resolved model changed before child creation.",
      );
    }

    const namespace = namespaceOf(context);
    const executionCwd = await this.resolveExecutionCwd(
      params.workspaceDir,
      context.cwd,
    );
    const sessionId = this.allocateSessionId(namespace);
    let pending: { finish(): void };
    try {
      pending = this.beginPendingPreparation(context);
    } catch (error) {
      this.releaseSessionIdReservation(sessionId, namespace);
      throw error;
    }
    const finishPendingPreparation = pending.finish;
    let extensionPreparation: ChildExtensionPreparation;
    try {
      if (!this.childFactory.prepareExtensions)
        throw new Error("Resource loading unavailable.");
      extensionPreparation = await this.childFactory.prepareExtensions({
        cwd: context.cwd,
        agentDir: this.options.agentDir,
        systemPrompt: agent.systemPrompt,
        extensions: [...(agent.extensions ?? [])],
        modelRegistry: context.modelRegistry,
      });
    } catch (cause) {
      finishPendingPreparation();
      this.releaseSessionIdReservation(sessionId, namespace);
      this.assertOperationActive(operation);
      throw new MinimalSubagentsError(
        "EXTENSION_LOAD_FAILED",
        `Agent "${agent.name}" extensions could not be loaded.`,
        { cause },
      );
    }
    const preparationOwner = new ExtensionPreparationOwner(
      extensionPreparation,
    );
    try {
      this.assertOperationActive(operation);
      this.assertNamespaceOpen(context);
    } catch (error) {
      preparationOwner.dispose();
      finishPendingPreparation();
      this.releaseSessionIdReservation(sessionId, namespace);
      throw error;
    }

    const resolvedTools = resolveCapabilities(
      agent.tools,
      agent.disallowedTools,
      extensionPreparation.knownToolNames,
    );
    const resolvedSkills = resolveCapabilities(
      agent.skills,
      agent.disallowedSkills,
      extensionPreparation.knownSkillNames ?? [],
    );
    if (resolvedTools === undefined || resolvedSkills === undefined) {
      preparationOwner.dispose();
      finishPendingPreparation();
      this.releaseSessionIdReservation(sessionId, namespace);
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        `Agent "${agent.name}" references an unavailable capability.`,
      );
    }

    let store: SessionRecordStore;
    let queued: PersistedSessionSnapshot;
    let record: LiveRecord;
    let queuedWrite: Promise<void>;
    let execution: Promise<PersistedSessionSnapshot>;
    let setupRecord: LiveRecord | undefined;
    try {
      store = this.createStore(context);
      queued = {
        session_id: sessionId,
        agent: agent.name,
        model: resolved.model,
        thinking: resolved.thinking,
        status: "queued",
        created_at: this.now(),
      };
      const shutdownSignal = createShutdownSignal();
      record = {
        snapshot: copy(queued),
        activeSnapshot: copy(queued),
        shutdownSignal: shutdownSignal.promise,
        forceShutdownSettlement: shutdownSignal.resolve,
        namespace,
        store,
        context,
        published: false,
        taskLabel: deriveLabel(prompt),
        widgetVisible: true,
        ...(preparationOwner !== undefined
          ? { extensionPreparation: preparationOwner }
          : {}),
        path: sessionRecordPath({
          agentDir: this.options.agentDir,
          projectPath: context.cwd,
          parentSessionId: context.sessionManager.getSessionId(),
          sessionId,
        }),
      };
      setupRecord = record;
      this.records.set(sessionId, record);
      this.releaseSessionIdReservation(sessionId, namespace);
      this.enqueue(record);
      queuedWrite = this.trackPersistence(record, store.writeSession(queued));
      execution = this.executeNew({
        queuedWrite,
        store,
        context,
        executionCwd,
        record,
        queued,
        prompt,
        concrete: concrete as Model<Api>,
        agent,
        tools: resolvedTools,
        skills: resolvedSkills,
        lifecycle,
      });
      record.execution = execution;
      finishPendingPreparation();
    } catch (cause) {
      finishPendingPreparation();
      this.releaseSessionIdReservation(sessionId, namespace);
      if (setupRecord !== undefined) {
        this.cancelAdmission(setupRecord);
        this.records.delete(setupRecord.snapshot.session_id);
      }
      preparationOwner?.dispose();
      throw cause;
    }
    try {
      await queuedWrite;
    } catch (cause) {
      if (record.operationAborted) {
        await record.abortSettlement;
        return copy(record.snapshot);
      }
      if (record.shutdownMarked) {
        await this.namespaces.get(record.namespace)?.shutdown;
        return copy(record.snapshot);
      }
      this.cancelAdmission(record);
      preparationOwner?.dispose();
      this.records.delete(sessionId);
      record.execution = undefined;
      this.refreshView(record.namespace, context);
      throw cause;
    }
    if (record.operationAborted) {
      await record.abortSettlement;
      return copy(record.snapshot);
    }
    if (record.shutdownMarked) {
      await this.namespaces.get(record.namespace)?.shutdown;
      return copy(record.snapshot);
    }
    record.task = execution
      .then(
        () => undefined,
        () => {
          if (!record.shutdownMarked && !record.operationAborted)
            notifyWarning(record.context?.ui, ASYNC_EXECUTION_WARNING);
        },
      )
      .finally(() => {
        if (!record.shutdownMarked && !record.operationAborted) {
          record.task = undefined;
          record.execution = undefined;
        }
      });
    return copy({ ...queued, ...warning(params.session_id) });
  }

  async output(params: SubagentOutputParams): Promise<unknown> {
    if (!isSessionId(params.session_id)) {
      throw new MinimalSubagentsError(
        "SESSION_NOT_FOUND",
        "The session was not found.",
      );
    }
    const record = this.records.get(params.session_id);
    const snapshot = record?.published === false ? undefined : record?.snapshot;
    if (!snapshot) {
      throw new MinimalSubagentsError(
        "SESSION_NOT_FOUND",
        "The session was not found.",
      );
    }
    return copy({
      session_id: snapshot.session_id,
      agent: snapshot.agent,
      model: snapshot.model,
      thinking: snapshot.thinking,
      status: snapshot.status,
      ...(snapshot.output !== undefined ? { output: snapshot.output } : {}),
      ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
      ...(snapshot.usage !== undefined ? { usage: snapshot.usage } : {}),
    });
  }

  private async resume(
    params: SubagentCallParams,
    context: ExtensionContext,
    lifecycle?: SessionCallLifecycle,
    operation?: OperationAbortBinding,
  ): Promise<SessionCallResult> {
    this.assertOperationActive(operation);
    const prompt = params.prompt.trim();
    if (prompt === "") {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "prompt must be non-empty.",
      );
    }
    if (params.agent !== undefined) {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "resume cannot change agent.",
      );
    }
    if (params.workspaceDir !== undefined) {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "resume cannot change workspaceDir.",
      );
    }
    if (params.session_id === undefined || params.session_id.trim() === "") {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "session_id is required for resume.",
      );
    }
    const record = isSessionId(params.session_id)
      ? this.records.get(params.session_id)
      : undefined;
    if (!record || record.namespace !== namespaceOf(context)) {
      throw new MinimalSubagentsError(
        "SESSION_NOT_FOUND",
        "The session was not found.",
      );
    }
    if (
      record.reserved ||
      record.task ||
      !isTerminalStatus(record.snapshot.status)
    ) {
      throw new MinimalSubagentsError(
        "SESSION_BUSY",
        "The session already has an active turn.",
      );
    }
    if (!record.child) {
      throw new MinimalSubagentsError(
        "SESSION_NOT_RESUMABLE",
        "The session has no live conversation to resume.",
      );
    }

    const currentAgent = this.registry.findCurrent(record.snapshot.agent);
    const resolved = resolveInvocationModelThinking({
      invocationModel: params.model,
      invocationThinking: params.thinking,
      agent: currentAgent,
      config: this.options.config,
      parent: {
        ...(context.model ? { model: context.model } : {}),
        ...(context.thinkingLevel !== undefined
          ? { thinking: context.thinkingLevel }
          : {}),
      },
      catalog: context.modelRegistry.getAll(),
    });
    const modelChanged = resolved.model !== record.snapshot.model;
    const thinkingChanged = resolved.thinking !== record.snapshot.thinking;
    let configuration:
      | { model?: Model<Api>; thinking?: PersistedSessionSnapshot["thinking"] }
      | undefined;
    if (modelChanged) {
      const [provider, ...modelParts] = resolved.model.split("/");
      const concrete = context.modelRegistry.find(
        provider!,
        modelParts.join("/"),
      );
      if (!concrete) {
        throw new MinimalSubagentsError(
          "INTERNAL_ERROR",
          "The resolved model changed before session resume.",
        );
      }
      configuration = {
        model: concrete as Model<Api>,
        thinking: resolved.thinking,
      };
    } else if (thinkingChanged) {
      configuration = { thinking: resolved.thinking };
    }

    const priorProcessState = {
      reserved: record.reserved,
      execution: record.execution,
      settlement: record.settlement,
      abortRequest: record.abortRequest,
      observation: record.observation,
      progress: record.progress,
      shutdownSignal: record.shutdownSignal,
      forceShutdownSettlement: record.forceShutdownSettlement,
      store: record.store,
      context: record.context,
      activeSnapshot: record.activeSnapshot,
      taskLabel: record.taskLabel,
      pushed: record.pushed,
      published: record.published,
      widgetVisible: record.widgetVisible,
      readyForAdmission: record.readyForAdmission,
      admissionResolve: record.admissionResolve,
      admission: record.admission,
      holdsSlot: record.holdsSlot,
      operationAborted: record.operationAborted,
      abortSettlement: record.abortSettlement,
      persistence: record.persistence,
      creation: record.creation,
      settlementClaim: record.settlementClaim,
    };
    record.reserved = true;
    record.settlement = undefined;
    record.settlementClaim = undefined;
    record.abortRequest = undefined;
    record.abortSettlement = undefined;
    record.creation = undefined;
    record.operationAborted = undefined;
    record.observation = undefined;
    record.progress = undefined;
    const shutdownSignal = createShutdownSignal();
    record.shutdownSignal = shutdownSignal.promise;
    record.forceShutdownSettlement = shutdownSignal.resolve;
    const previous = record.snapshot;
    const queued: PersistedSessionSnapshot = {
      session_id: previous.session_id,
      agent: previous.agent,
      model: resolved.model,
      thinking: resolved.thinking,
      status: "queued",
      created_at: previous.created_at,
      ...(previous.metadata !== undefined
        ? { metadata: copy(previous.metadata) }
        : {}),
    };
    const store = this.createStore(context);
    record.store = store;
    record.context = context;
    record.activeSnapshot = copy(queued);
    record.taskLabel = deriveLabel(prompt);
    record.pushed = false;
    record.published = false;
    record.widgetVisible = true;
    this.enqueue(record);
    const queuedWrite = this.trackPersistence(
      record,
      store.writeSession(queued),
    );
    const execution = this.executeResume({
      queuedWrite,
      store,
      context,
      record,
      queued,
      prompt,
      child: record.child,
      configuration,
      lifecycle,
    });
    record.execution = execution;

    try {
      await queuedWrite;
    } catch (cause) {
      if (record.operationAborted) {
        await record.abortSettlement;
        return copy(record.snapshot);
      }
      if (record.shutdownMarked) {
        await this.namespaces.get(record.namespace)?.shutdown;
        return copy(record.snapshot);
      }
      this.cancelAdmission(record, () =>
        Object.assign(record, priorProcessState),
      );
      this.refreshView(record.namespace, context);
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "Failed to persist the queued child session record.",
        { cause },
      );
    }
    if (record.operationAborted) {
      await record.abortSettlement;
      return copy(record.snapshot);
    }
    if (record.shutdownMarked) {
      await this.namespaces.get(record.namespace)?.shutdown;
      return copy(record.snapshot);
    }

    record.task = execution
      .catch(() => {
        if (!record.shutdownMarked && !record.operationAborted)
          notifyWarning(record.context?.ui, ASYNC_EXECUTION_WARNING);
      })
      .finally(() => {
        if (!record.shutdownMarked && !record.operationAborted) {
          record.task = undefined;
          record.execution = undefined;
          record.reserved = false;
        }
      });
    return copy(queued);
  }

  private async steer(
    params: SubagentCallParams,
    context: ExtensionContext,
    lifecycle?: SessionCallLifecycle,
  ): Promise<SessionSteerResult> {
    this.assertNamespaceOpen(context);
    const prompt = params.prompt.trim();
    if (prompt === "") {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "prompt must be non-empty.",
      );
    }
    if (
      params.agent !== undefined ||
      params.model !== undefined ||
      params.thinking !== undefined ||
      params.workspaceDir !== undefined
    ) {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "steer cannot change agent, model, thinking, or workspaceDir.",
      );
    }
    if (params.session_id === undefined || params.session_id.trim() === "") {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "session_id is required for steer.",
      );
    }
    const record = isSessionId(params.session_id)
      ? this.records.get(params.session_id)
      : undefined;
    if (!record || record.namespace !== namespaceOf(context)) {
      throw new MinimalSubagentsError(
        "SESSION_NOT_FOUND",
        "The session was not found.",
      );
    }
    if (record.snapshot.status !== "running" || !record.child) {
      throw new MinimalSubagentsError(
        "SESSION_NOT_RUNNING",
        "The session is not running.",
      );
    }

    try {
      lifecycle?.identified(record.snapshot.agent);
    } catch {
      // Display notifications must not affect child execution.
    }
    try {
      const acknowledgement = record.child.steer(prompt);
      await acknowledgement;
    } catch (cause) {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "The child session could not be steered.",
        { cause },
      );
    }
    return {
      session_id: record.snapshot.session_id,
      status: "running",
      steered: true,
    };
  }

  /** Close one parent namespace and await best-effort settlement of all active children. */
  shutdown(context: ExtensionContext): Promise<void> {
    const namespace = namespaceOf(context);
    const existing = this.namespaces.get(namespace);
    if (existing?.shutdown) return existing.shutdown;

    const state: NamespaceState = existing ?? {
      closed: false,
      pendingPreparations: new Set(),
    };
    state.closed = true;
    this.namespaces.set(namespace, state);

    const namespaceRecords = [...this.records.values()].filter(
      (record) => record.namespace === namespace,
    );
    const active = namespaceRecords.filter(
      (record) =>
        record.settlement !== "terminal" &&
        (record.reserved === true ||
          record.execution !== undefined ||
          record.snapshot.status === "queued" ||
          record.snapshot.status === "running"),
    );
    const ownedExecutions = namespaceRecords.flatMap((record) =>
      record.execution ? [record.execution] : [],
    );
    for (const record of active) {
      record.shutdownMarked = true;
      if (!record.holdsSlot) this.cancelAdmission(record);
    }
    const aborts = active.map((record) => this.requestAbort(record));
    state.shutdown = this.finishShutdown(
      active,
      ownedExecutions,
      aborts,
      namespaceRecords,
      [...state.pendingPreparations],
    );
    return state.shutdown;
  }

  /**
   * Bind a host `subagent_call` operation signal so aborting the parent
   * operation aborts every queued/running record in each observed parent
   * namespace. One listener per signal (deduplicated via weak keys) survives
   * prompt background acceptance; operation abort never closes the namespace.
   * An already-aborted signal aborts existing records synchronously. The
   * returned guard also lets a call notice abort after pre-record awaits.
   */
  bindOperationSignal(
    signal: AbortSignal | undefined | null,
    context: ExtensionContext,
  ): OperationAbortBinding | undefined {
    if (!signal || typeof signal.addEventListener !== "function") return;
    const namespace = namespaceOf(context);
    const existing = this.operationAbortBindings.get(signal);
    if (existing) {
      existing.namespaces.add(namespace);
      if (signal.aborted && !existing.aborted) existing.onAbort();
      else if (signal.aborted) this.abortBoundNamespaces(existing.namespaces);
      return existing;
    }
    const binding: OperationAbortBinding = {
      namespaces: new Set<string>([namespace]),
      aborted: false,
      onAbort: () => {
        binding.aborted = true;
        this.abortBoundNamespaces(binding.namespaces);
      },
    };
    this.operationAbortBindings.set(signal, binding);
    if (signal.aborted) binding.onAbort();
    else signal.addEventListener("abort", binding.onAbort, { once: true });
    return binding;
  }

  /** Hide terminal rows at a parent input boundary. */
  onParentInput(context: ExtensionContext): void {
    const namespace = namespaceOf(context);
    for (const record of this.records.values()) {
      if (
        record.namespace === namespace &&
        (record.settlement === "terminal" || record.settlement === "shutdown")
      ) {
        record.widgetVisible = false;
      }
    }
    const view = this.views.get(namespace);
    if (!view) return;
    const rows = view.refresh(Date.parse(this.now()));
    if (rows.length === 0) this.views.delete(namespace);
  }

  sessionStatus(): SessionStatusResult {
    const snapshots = [...this.records.values()]
      .filter((record) => record.published !== false)
      .map((record) => record.snapshot);
    const active = snapshots
      .filter(
        (snapshot) =>
          snapshot.status === "queued" || snapshot.status === "running",
      )
      .sort((left, right) => {
        const byTime = (left.started_at ?? left.created_at).localeCompare(
          right.started_at ?? right.created_at,
        );
        return byTime || left.session_id.localeCompare(right.session_id);
      })
      .map((snapshot) => ({
        session_id: snapshot.session_id as SessionId,
        agent: snapshot.agent,
        status: snapshot.status,
        started_at: snapshot.started_at ?? snapshot.created_at,
      }));
    const recent = snapshots
      .filter((snapshot) => isTerminalStatus(snapshot.status))
      .sort((left, right) => {
        const byTime = right.completed_at!.localeCompare(left.completed_at!);
        return byTime || left.session_id.localeCompare(right.session_id);
      })
      .map((snapshot) => ({
        session_id: snapshot.session_id as SessionId,
        agent: snapshot.agent,
        status: snapshot.status,
        completed_at: snapshot.completed_at,
      }));
    return copy({ active_sessions: active, recent_sessions: recent });
  }

  /** Replace one cwd/parent namespace with restart-normalized stored records. */
  async load(context: ExtensionContext): Promise<void> {
    const namespace = namespaceOf(context);
    const baseline = new Map<string, LoadBaselineRecord>();
    for (const [id, record] of this.records) {
      if (record.namespace === namespace) {
        baseline.set(id, {
          record,
          state: captureLiveRecordState(record),
        });
      }
    }
    await this.namespaces.get(namespace)?.shutdown;
    const store = this.createStore(context);
    if (!store.loadSessions) return;
    const loaded = await store.loadSessions();
    for (const [id, before] of baseline) {
      const current = this.records.get(id);
      if (
        current === before.record &&
        !ownsLiveSession(current) &&
        liveRecordStateMatches(current, before.state)
      ) {
        this.records.delete(id);
      }
    }
    for (const snapshot of loaded.records) {
      const path = sessionRecordPath({
        agentDir: this.options.agentDir,
        projectPath: context.cwd,
        parentSessionId: context.sessionManager.getSessionId(),
        sessionId: snapshot.session_id,
      });
      const existing = this.records.get(snapshot.session_id);
      const reservationNamespace = this.sessionIdReservations.get(
        snapshot.session_id,
      );
      if (existing !== undefined || reservationNamespace !== undefined) {
        notifyWarning(
          context.ui,
          `[pi-subagents-minimal] ${path}: ${LOAD_SESSION_ID_COLLISION_WARNING}`,
        );
        continue;
      }
      this.records.set(snapshot.session_id, {
        snapshot: copy(snapshot),
        namespace,
        published: true,
        path,
      });
    }
    for (const warning of loaded.warnings) {
      notifyWarning(
        context.ui,
        `[pi-subagents-minimal] ${warning.path}: ${warning.message}`,
      );
    }
  }

  /** Test/recovery seam. */
  getSnapshot(sessionId: string): PersistedSessionSnapshot | undefined {
    const snapshot = this.records.get(sessionId)?.snapshot;
    return snapshot === undefined ? undefined : copy(snapshot);
  }

  /**
   * Validate an optional isolated workspace directory for `type: "new"`.
   * Omission preserves the parent `context.cwd`. A supplied value must be a
   * non-blank absolute path to an existing directory; failures use a fixed
   * redacted message that never exposes the supplied path or filesystem
   * details. Runs before ID allocation, persistence, extension preparation,
   * or child creation.
   */
  private async resolveExecutionCwd(
    workspaceDir: string | undefined,
    parentCwd: string,
  ): Promise<string> {
    if (workspaceDir === undefined) return parentCwd;
    if (
      typeof workspaceDir !== "string" ||
      workspaceDir.trim() === "" ||
      !isAbsolute(workspaceDir)
    ) {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "workspaceDir must be a non-blank absolute path to an existing directory.",
      );
    }
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(workspaceDir)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new MinimalSubagentsError(
        "INVALID_ARGUMENT",
        "workspaceDir must be a non-blank absolute path to an existing directory.",
      );
    }
    return workspaceDir;
  }

  private allocateSessionId(namespace: string): SessionId {
    for (let attempt = 0; attempt < 16; attempt++) {
      let candidate: string;
      try {
        candidate = this.createId();
      } catch (cause) {
        throw new MinimalSubagentsError(
          "INTERNAL_ERROR",
          "A session ID could not be allocated.",
          { cause },
        );
      }
      if (!isSessionId(candidate)) {
        throw new MinimalSubagentsError(
          "INTERNAL_ERROR",
          "A session ID could not be allocated.",
        );
      }
      if (
        !this.records.has(candidate) &&
        !this.sessionIdReservations.has(candidate)
      ) {
        this.sessionIdReservations.set(candidate, namespace);
        return candidate;
      }
    }
    throw new MinimalSubagentsError(
      "INTERNAL_ERROR",
      "A session ID could not be allocated.",
    );
  }

  private releaseSessionIdReservation(
    sessionId: SessionId,
    namespace: string,
  ): void {
    if (this.sessionIdReservations.get(sessionId) === namespace) {
      this.sessionIdReservations.delete(sessionId);
    }
  }

  private beginPendingPreparation(context: ExtensionContext): {
    finish(): void;
  } {
    const namespace = namespaceOf(context);
    const state = this.namespaces.get(namespace) ?? {
      closed: false,
      pendingPreparations: new Set<Promise<void>>(),
    };
    if (state.closed) {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "The parent session is shutting down.",
      );
    }
    this.namespaces.set(namespace, state);
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    state.pendingPreparations.add(pending);
    let finished = false;
    return {
      finish: () => {
        if (finished) return;
        finished = true;
        state.pendingPreparations.delete(pending);
        resolve();
      },
    };
  }

  private assertOperationActive(operation?: OperationAbortBinding): void {
    if (!operation?.aborted) return;
    throw new MinimalSubagentsError(
      "INTERNAL_ERROR",
      "The parent operation was aborted.",
    );
  }

  private assertNamespaceOpen(context: ExtensionContext): void {
    if (!context.sessionManager) return;
    if (this.namespaces.get(namespaceOf(context))?.closed) {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "The parent session is shutting down.",
      );
    }
  }

  private requestAbort(record: LiveRecord): Promise<void> {
    if (record.abortRequest) return record.abortRequest;
    if (!record.child) return Promise.resolve();
    try {
      record.abortRequest = record.child.abort().catch(() => {
        notifyWarning(record.context?.ui, SHUTDOWN_ABORT_WARNING);
        record.forceShutdownSettlement?.();
      });
    } catch {
      notifyWarning(record.context?.ui, SHUTDOWN_ABORT_WARNING);
      record.forceShutdownSettlement?.();
      record.abortRequest = Promise.resolve();
    }
    return record.abortRequest;
  }

  private abortBoundNamespaces(namespaces: Set<string>): void {
    for (const namespace of [...namespaces]) {
      this.abortNamespaceRecords(namespace);
    }
  }

  /**
   * Abort every non-terminal queued/running record in one namespace without
   * closing it. Waiting records never create a child; started records reuse
   * the idempotent child abort. Settlement reuses the terminal `aborted`
   * publication, slot release, and view refresh, but the completion push is
   * suppressed because the parent operation itself was aborted.
   */
  private abortNamespaceRecords(namespace: string): void {
    const targets = [...this.records.values()].filter(
      (record) =>
        record.namespace === namespace &&
        record.settlement === undefined &&
        (record.reserved === true ||
          record.execution !== undefined ||
          record.snapshot.status === "queued" ||
          record.snapshot.status === "running"),
    );
    for (const record of targets) record.operationAborted = true;
    for (const record of targets) {
      const index = this.waiters.indexOf(record);
      if (index >= 0) this.waiters.splice(index, 1);
      record.admissionResolve?.(false);
      record.admissionResolve = undefined;
    }
    this.pump();
    for (const record of targets) {
      record.abortSettlement ??= this.settleOperationAbort(record);
    }
  }

  private async settleOperationAbort(record: LiveRecord): Promise<void> {
    if (record.settlement !== undefined) return;
    if (record.creation) await Promise.allSettled([record.creation]);
    await this.requestAbort(record);
    if (record.execution) await Promise.allSettled([record.execution]);
    await this.drainPersistence(record);
    if (
      record.settlement !== undefined ||
      (record.settlementClaim !== undefined &&
        record.settlementClaim !== "operation")
    ) {
      return;
    }
    record.settlementClaim = "operation";
    const base = record.activeSnapshot ?? record.snapshot;
    const observation = record.observation;
    const aborted: PersistedSessionSnapshot = {
      ...base,
      status: "aborted",
      completed_at: this.now(),
      ...(observation?.output !== undefined
        ? { output: observation.output }
        : {}),
      ...(observation?.usage !== undefined ? { usage: observation.usage } : {}),
      error: { ...PARENT_SHUTDOWN_ERROR },
    };
    record.extensionPreparation?.dispose();
    record.extensionPreparation = undefined;
    let persisted = false;
    try {
      await record.store?.writeSession(aborted);
      persisted = true;
    } catch {
      notifyWarning(record.context?.ui, SHUTDOWN_PERSISTENCE_WARNING);
    }
    record.snapshot = copy(aborted);
    record.published = true;
    record.settlement = "terminal";
    this.releaseSlot(record);
    if (record.context) {
      this.refreshView(record.namespace, record.context);
      this.pushCompletion(record);
    }
    if (persisted && record.context) await this.runCleanup(record.context);
    record.task = undefined;
    record.execution = undefined;
    record.progress = undefined;
    record.reserved = false;
  }

  private async finishShutdown(
    records: LiveRecord[],
    executions: Promise<PersistedSessionSnapshot>[],
    aborts: Promise<void>[],
    namespaceRecords: LiveRecord[],
    pendingPreparations: Promise<void>[],
  ): Promise<void> {
    await Promise.allSettled(pendingPreparations);
    await Promise.allSettled(aborts);
    await Promise.allSettled(executions);
    await Promise.allSettled(
      records.map((record) => record.progress ?? Promise.resolve()),
    );
    await Promise.allSettled(
      records.map((record) => this.settleShutdownRecord(record)),
    );
    for (const record of namespaceRecords) {
      record.extensionPreparation?.dispose();
      record.extensionPreparation = undefined;
      try {
        record.child?.dispose?.();
      } catch {
        // Pi's public dispose is best-effort and must not break parent shutdown.
      }
      record.child = undefined;
    }
  }

  private async settleShutdownRecord(record: LiveRecord): Promise<void> {
    if (record.settlement !== undefined) return;
    if (record.settlementClaim === "operation") {
      await record.abortSettlement;
      return;
    }
    if (record.settlementClaim !== undefined) return;
    record.settlementClaim = "shutdown";
    const base = record.activeSnapshot ?? record.snapshot;
    const observation = record.observation;
    const aborted: PersistedSessionSnapshot = {
      ...base,
      status: "aborted",
      completed_at: this.now(),
      ...(observation?.output !== undefined
        ? { output: observation.output }
        : {}),
      ...(observation?.usage !== undefined ? { usage: observation.usage } : {}),
      error: { ...PARENT_SHUTDOWN_ERROR },
    };
    let persisted = false;
    try {
      await record.store?.writeSession(aborted);
      persisted = true;
    } catch {
      notifyWarning(record.context?.ui, SHUTDOWN_PERSISTENCE_WARNING);
    }
    record.snapshot = copy(aborted);
    record.published = true;
    record.settlement = "shutdown";
    this.releaseSlot(record);
    if (record.context) {
      this.refreshView(record.namespace, record.context);
      this.pushCompletion(record);
    }
    if (persisted && record.context) await this.runCleanup(record.context);
    record.task = undefined;
    record.execution = undefined;
    record.progress = undefined;
    record.reserved = false;
  }

  private async executeNew(input: {
    queuedWrite: Promise<void>;
    store: SessionRecordStore;
    context: ExtensionContext;
    executionCwd: string;
    record: LiveRecord;
    queued: PersistedSessionSnapshot;
    prompt: string;
    concrete: Model<Api>;
    agent: ReturnType<
      ReturnType<typeof createAgentRegistry>["findForSession"]
    > & {};
    tools: string[];
    skills: string[];
    lifecycle?: SessionCallLifecycle;
  }): Promise<PersistedSessionSnapshot> {
    const {
      queuedWrite,
      store,
      context,
      executionCwd,
      record,
      queued,
      prompt,
      concrete,
      agent,
      tools,
      skills,
      lifecycle,
    } = input;
    try {
      await queuedWrite;
    } catch {
      return copy(record.activeSnapshot ?? queued);
    }
    if (record.operationAborted || record.settlement !== undefined) {
      return copy(record.snapshot);
    }
    record.published = true;
    this.refreshView(record.namespace, context);
    record.readyForAdmission = true;
    this.pump();
    if (
      !(await record.admission) ||
      record.shutdownMarked ||
      record.operationAborted
    ) {
      record.extensionPreparation?.dispose();
      record.extensionPreparation = undefined;
      return copy(record.activeSnapshot ?? queued);
    }
    this.refreshView(record.namespace, context);
    let child: ChildSessionHandle;
    try {
      const creation = this.childFactory
        .create({
          id: queued.session_id,
          cwd: executionCwd,
          agentDir: this.options.agentDir,
          parentSessionId: context.sessionManager.getSessionId(),
          model: concrete,
          modelRegistry: context.modelRegistry,
          thinking: queued.thinking,
          systemPrompt: agent.systemPrompt,
          tools: [...tools],
          skills: [...skills],
          ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
          ...(record.extensionPreparation !== undefined
            ? { extensionPreparation: record.extensionPreparation.preparation }
            : {}),
        })
        .then((created) => {
          record.child = created;
          record.extensionPreparation?.transfer();
          record.extensionPreparation = undefined;
          return created;
        });
      record.creation = creation;
      child = await creation;
      try {
        lifecycle?.identified(agent.name);
      } catch {
        // Display notifications must not affect child execution.
      }
    } catch {
      record.extensionPreparation?.dispose();
      record.extensionPreparation = undefined;
      if (record.shutdownMarked || record.operationAborted)
        return copy(record.activeSnapshot ?? queued);
      return this.persistTerminal(
        store,
        context,
        record,
        failedSnapshot(queued, this.now()),
      );
    }
    if (record.shutdownMarked || record.operationAborted) {
      await this.requestAbort(record);
      return copy(record.activeSnapshot ?? queued);
    }

    return this.executePrompt({
      store,
      context,
      record,
      queued,
      prompt,
      child,
    });
  }

  private async executeResume(input: {
    queuedWrite: Promise<void>;
    store: SessionRecordStore;
    context: ExtensionContext;
    record: LiveRecord;
    queued: PersistedSessionSnapshot;
    prompt: string;
    child: ChildSessionHandle;
    configuration?: {
      model?: Model<Api>;
      thinking?: PersistedSessionSnapshot["thinking"];
    };
    lifecycle?: SessionCallLifecycle;
  }): Promise<PersistedSessionSnapshot> {
    const {
      queuedWrite,
      store,
      context,
      record,
      queued,
      prompt,
      child,
      configuration,
      lifecycle,
    } = input;
    try {
      await queuedWrite;
    } catch {
      return copy(record.activeSnapshot ?? record.snapshot);
    }
    if (record.operationAborted || record.settlement !== undefined) {
      return copy(record.snapshot);
    }
    record.published = true;
    record.snapshot = copy(queued);
    this.refreshView(record.namespace, context);
    record.readyForAdmission = true;
    this.pump();
    if (
      !(await record.admission) ||
      record.shutdownMarked ||
      record.operationAborted
    ) {
      return copy(record.activeSnapshot ?? queued);
    }
    this.refreshView(record.namespace, context);
    if (configuration !== undefined) {
      try {
        await child.configure(configuration);
      } catch {
        if (record.shutdownMarked || record.operationAborted)
          return copy(record.activeSnapshot ?? queued);
        try {
          child.dispose?.();
        } catch {
          // A failed reconfiguration makes the retained conversation unusable;
          // disposal remains best-effort and must not expose host errors.
        }
        record.child = undefined;
        return this.persistTerminal(
          store,
          context,
          record,
          failedSnapshot(queued, this.now()),
        );
      }
      if (record.shutdownMarked || record.operationAborted)
        return copy(record.activeSnapshot ?? queued);
    }
    try {
      lifecycle?.identified(queued.agent);
    } catch {
      // Display notifications must not affect child execution.
    }
    return this.executePrompt({
      store,
      context,
      record,
      queued,
      prompt,
      child,
    });
  }

  private async executePrompt(input: {
    store: SessionRecordStore;
    context: ExtensionContext;
    record: LiveRecord;
    queued: PersistedSessionSnapshot;
    prompt: string;
    child: ChildSessionHandle;
  }): Promise<PersistedSessionSnapshot> {
    const { store, context, record, queued, prompt, child } = input;
    const running: PersistedSessionSnapshot = {
      ...queued,
      status: "running",
      started_at: this.now(),
    };
    record.activeSnapshot = copy(running);
    try {
      await this.trackPersistence(record, store.writeSession(running));
      if (record.shutdownMarked || record.operationAborted)
        return copy(running);
      record.snapshot = copy(running);
      this.refreshView(record.namespace, context);
    } catch {
      if (record.shutdownMarked || record.operationAborted)
        return copy(running);
      return this.persistTerminal(
        store,
        context,
        record,
        failedSnapshot(queued, this.now()),
      );
    }

    let progressWrites = Promise.resolve();
    record.progress = progressWrites;
    const refresh = (observation: ChildExecutionObservation) => {
      if (record.shutdownMarked || record.operationAborted) return;
      record.observation = copy(observation);
      this.refreshView(record.namespace, context);
      const progress: PersistedSessionSnapshot = {
        ...running,
        ...(observation.output !== undefined
          ? { output: observation.output }
          : {}),
        ...(observation.usage !== undefined
          ? { usage: observation.usage }
          : {}),
      };
      progressWrites = progressWrites.then(async () => {
        try {
          await this.trackPersistence(record, store.writeSession(progress));
          if (!record.shutdownMarked && !record.operationAborted) {
            record.snapshot = copy(progress);
            this.refreshView(record.namespace, context);
          }
        } catch {
          notifyWarning(context.ui, PROGRESS_WRITE_WARNING);
        }
      });
      record.progress = progressWrites;
    };

    let terminal: PersistedSessionSnapshot;
    try {
      const promptSettlement = child.prompt(prompt, refresh).then(
        (observation) => ({ kind: "observation" as const, observation }),
        () => ({ kind: "error" as const }),
      );
      const outcome = record.shutdownSignal
        ? await Promise.race([
            promptSettlement,
            record.shutdownSignal.then(() => ({ kind: "shutdown" as const })),
          ])
        : await promptSettlement;
      if (outcome.kind === "observation") {
        record.observation = copy(outcome.observation);
      }
      await progressWrites;
      if (
        outcome.kind === "shutdown" ||
        record.shutdownMarked ||
        record.operationAborted
      ) {
        return copy(record.activeSnapshot ?? running);
      }
      terminal =
        outcome.kind === "error"
          ? failedSnapshot(running, this.now())
          : terminalSnapshot(running, outcome.observation, this.now());
    } catch {
      await progressWrites;
      if (record.shutdownMarked || record.operationAborted)
        return copy(record.activeSnapshot ?? running);
      terminal = failedSnapshot(running, this.now());
    }
    return this.persistTerminal(store, context, record, terminal);
  }

  private async persistTerminal(
    store: SessionRecordStore,
    context: ExtensionContext,
    record: LiveRecord,
    terminal: PersistedSessionSnapshot,
  ): Promise<PersistedSessionSnapshot> {
    if (
      record.settlement !== undefined ||
      record.settlementClaim !== undefined ||
      record.shutdownMarked ||
      record.operationAborted
    ) {
      return copy(record.snapshot);
    }
    let cause: unknown;
    try {
      await this.trackPersistence(record, store.writeSession(terminal));
    } catch (error) {
      cause = error;
    }
    if (
      record.settlement !== undefined ||
      record.settlementClaim !== undefined ||
      record.shutdownMarked ||
      record.operationAborted
    ) {
      return copy(record.snapshot);
    }
    record.settlementClaim = "natural";
    record.settlement = "terminal";
    record.snapshot = copy(terminal);
    record.published = true;
    this.releaseSlot(record);
    this.refreshView(record.namespace, context);
    this.pushCompletion(record);
    if (cause !== undefined) {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "Failed to persist the terminal child session record.",
        { cause },
      );
    }
    await this.runCleanup(context);
    return copy(terminal);
  }

  private trackPersistence<T>(
    record: LiveRecord,
    write: Promise<T>,
  ): Promise<T> {
    record.persistence = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async drainPersistence(record: LiveRecord): Promise<void> {
    while (record.persistence || record.progress) {
      const persistence = record.persistence;
      const progress = record.progress;
      await Promise.allSettled([
        persistence ?? Promise.resolve(),
        progress ?? Promise.resolve(),
      ]);
      if (record.persistence === persistence && record.progress === progress)
        return;
    }
  }

  private enqueue(record: LiveRecord): void {
    record.readyForAdmission = false;
    record.admission = new Promise<boolean>((resolve) => {
      record.admissionResolve = resolve;
    });
    this.waiters.push(record);
    this.waiters.sort((left, right) => {
      const byTime = left.activeSnapshot!.created_at.localeCompare(
        right.activeSnapshot!.created_at,
      );
      return (
        byTime ||
        left.snapshot.session_id.localeCompare(right.snapshot.session_id)
      );
    });
  }

  private pump(): void {
    let changed = false;
    while (this.runningSlots < this.maxConcurrent && this.waiters.length > 0) {
      const next = this.waiters[0]!;
      if (!next.readyForAdmission) break;
      this.waiters.shift();
      changed = true;
      if (next.shutdownMarked || next.operationAborted) {
        next.admissionResolve?.(false);
        next.admissionResolve = undefined;
        continue;
      }
      this.runningSlots += 1;
      next.holdsSlot = true;
      next.admissionResolve?.(true);
      next.admissionResolve = undefined;
    }
    if (changed) this.refreshViews();
  }

  private refreshViews(): void {
    for (const view of this.views.values()) view.refresh();
  }

  private cancelAdmission(record: LiveRecord, beforePump?: () => void): void {
    const index = this.waiters.indexOf(record);
    if (index >= 0) this.waiters.splice(index, 1);
    record.admissionResolve?.(false);
    record.admissionResolve = undefined;
    beforePump?.();
    this.pump();
  }

  private releaseSlot(record: LiveRecord): void {
    if (!record.holdsSlot) return;
    record.holdsSlot = false;
    this.runningSlots -= 1;
    this.pump();
  }

  private refreshView(namespace: string, context: ExtensionContext): void {
    let view = this.views.get(namespace);
    if (!view) {
      if (!context.ui || typeof context.ui.setWidget !== "function") return;
      view = new AgentsView(context.ui, (nowMs?: number) =>
        this.viewRows(namespace, nowMs),
      );
      this.views.set(namespace, view);
    }
    const rows = view.refresh(Date.parse(this.now()));
    if (rows.length === 0) this.views.delete(namespace);
  }

  private viewRows(
    namespace: string,
    nowMs: number = Date.parse(this.now()),
  ): AgentViewRow[] {
    const queuePositions = new Map(
      this.waiters.map((record, index) => [record, index + 1]),
    );
    const now = nowMs;
    return [...this.records.values()]
      .filter((record) => {
        if (record.namespace !== namespace || record.published === false)
          return false;
        if (
          (record.settlement === "terminal" ||
            record.settlement === "shutdown") &&
          isTerminalStatus(record.snapshot.status)
        ) {
          return record.widgetVisible !== false;
        }
        const snapshot = record.activeSnapshot ?? record.snapshot;
        return (
          (snapshot.status === "queued" || snapshot.status === "running") &&
          record.settlement !== "terminal" &&
          record.settlement !== "shutdown"
        );
      })
      .map((record) => {
        if (
          (record.settlement === "terminal" ||
            record.settlement === "shutdown") &&
          isTerminalStatus(record.snapshot.status)
        ) {
          const widgetUsage = record.observation?.widgetUsage;
          return {
            session_id: record.snapshot.session_id,
            agent: record.snapshot.agent,
            label: record.taskLabel ?? "",
            model: record.snapshot.model,
            thinking: record.snapshot.thinking,
            elapsedMs:
              Date.parse(record.snapshot.completed_at!) -
              Date.parse(record.snapshot.created_at),
            phase: record.snapshot.status,
            terminalStatus: record.snapshot.status,
            turns: widgetUsage?.turns ?? 0,
            ...(widgetUsage !== undefined
              ? {
                  inputTokens: widgetUsage.input,
                  outputTokens: widgetUsage.output,
                }
              : {}),
            createdAt: record.snapshot.created_at,
          };
        }
        const snapshot = record.activeSnapshot ?? record.snapshot;
        const queuePosition = queuePositions.get(record);
        const status =
          queuePosition === undefined && record.holdsSlot
            ? "running"
            : "queued";
        const turns = record.observation?.usage?.turns ?? 0;
        const tools = record.observation?.usage?.tool_uses ?? 0;
        const widgetUsage = record.observation?.widgetUsage;
        return {
          session_id: snapshot.session_id,
          agent: snapshot.agent,
          label: record.taskLabel ?? "",
          model: snapshot.model,
          thinking: snapshot.thinking,
          elapsedMs: now - Date.parse(snapshot.created_at),
          phase: derivePhase(status, queuePosition, turns, tools),
          turns: widgetUsage?.turns ?? 0,
          ...(widgetUsage !== undefined
            ? {
                inputTokens: widgetUsage.input,
                outputTokens: widgetUsage.output,
              }
            : {}),
          ...(queuePosition !== undefined ? { queuePosition } : {}),
          createdAt: snapshot.created_at,
        };
      });
  }

  private pushCompletion(record: LiveRecord): void {
    if (record.pushed || !isTerminalStatus(record.snapshot.status)) return;
    // A parent operation abort settles children as aborted, but must not wake a
    // new parent turn; shutdown races may still reach here after operation abort.
    if (record.operationAborted) return;
    record.pushed = true;
    const notifier =
      this.options.notifier ??
      (this.options.pi ? createHostNotifier(this.options.pi) : undefined);
    if (!notifier) return;
    try {
      Promise.resolve(
        notifier.notify({
          sessionId: record.snapshot.session_id,
          status: record.snapshot.status,
        }),
      ).catch(() => notifyWarning(record.context?.ui, ASYNC_PUSH_WARNING));
    } catch {
      notifyWarning(record.context?.ui, ASYNC_PUSH_WARNING);
    }
  }

  private async runCleanup(context: ExtensionContext): Promise<void> {
    try {
      const result = await this.cleanup(context);
      if (result && typeof result === "object" && "deletedPaths" in result) {
        const cleanupResult = result as CleanupResult;
        const deleted = new Set(cleanupResult.deletedPaths);
        for (const [id, retained] of this.records) {
          if (
            isTerminalStatus(retained.snapshot.status) &&
            deleted.has(retained.path)
          ) {
            this.records.delete(id);
          }
        }
        if (cleanupResult.warnings.length > 0) {
          notifyWarning(context.ui, RETENTION_CLEANUP_RESULT_WARNING);
        }
      }
    } catch {
      notifyWarning(context.ui, TERMINAL_CLEANUP_WARNING);
    }
  }
}
