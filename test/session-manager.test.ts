import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension, { createTools } from "../src/index.js";
import type {
  ChildExecutionObservation,
  ChildSessionCreateInput,
  ChildSessionFactory,
} from "../src/runtime/agent-runner.js";
import type { AsyncCompletionNotifier } from "../src/runtime/completion-notify.js";
import {
  LOAD_SESSION_ID_COLLISION_WARNING,
  SessionManager,
  type SessionRecordStore,
} from "../src/runtime/session-manager.js";
import { sessionRecordPath } from "../src/storage/paths.js";
import { RecordStore } from "../src/storage/record-store.js";
import { RETENTION_CLEANUP_RESULT_WARNING } from "../src/storage/retention.js";
import type { PersistedSessionSnapshot } from "../src/storage/schemas.js";
import type { AgentDefinition, ThinkingLevel } from "../src/types.js";

function model(provider = "acme", id = "model", reasoning = true): Model<Api> {
  return { provider, id, reasoning } as unknown as Model<Api>;
}

const baseAgent: AgentDefinition = {
  name: "worker",
  description: "Worker.",
  tools: [],
  disallowedTools: [],
  skills: [],
  disallowedSkills: [],
  enabled: true,
  systemPrompt: "You are the child.",
  source: "project",
  sourcePath: "/agents/worker.md",
};

function harness(
  options: {
    agent?: AgentDefinition;
    currentAgentMissing?: boolean;
    observation?: ChildExecutionObservation;
    createError?: boolean;
    createErrorIds?: string[];
    extensionToolNames?: string[];
    extensionSkillNames?: string[];
    extensionPrepareError?: boolean;
    extensionPrepareFailures?: number[];
    beforePrepareReturn?: () => Promise<void>;
    createIdError?: boolean;
    createStoreError?: boolean;
    promptError?: boolean;
    beforeCreateReturn?: (input: ChildSessionCreateInput) => Promise<void>;
    failWrite?: number;
    failWrites?: number[];
    writeImpl?: (
      snapshot: PersistedSessionSnapshot,
      count: number,
    ) => Promise<void>;
    promptImpl?: (
      prompt: string,
      progress?: (observation: ChildExecutionObservation) => void,
    ) => Promise<ChildExecutionObservation>;
    configureImpl?: (configuration: {
      model?: Model<Api>;
      thinking?: ThinkingLevel;
    }) => Promise<void>;
    steerImpl?: (prompt: string) => Promise<void>;
    abortImpl?: () => Promise<void>;
    loaded?: PersistedSessionSnapshot[];
    loadImpl?: () => Promise<{
      records: PersistedSessionSnapshot[];
      warnings: [];
    }>;
    cleanupResult?: unknown;
    cleanupError?: string;
    createIds?: string[];
    store?: SessionRecordStore;
    parentModel?: Model<Api>;
    parentThinking?: ThinkingLevel;
    catalog?: Model<Api>[];
    maxConcurrent?: number;
    notifier?: AsyncCompletionNotifier;
    ui?: ExtensionContext["ui"];
    pi?: Pick<ExtensionAPI, "sendMessage">;
    now?: () => string;
  } = {},
) {
  const calls: string[] = [];
  const writes: PersistedSessionSnapshot[] = [];
  const createInputs: ChildSessionCreateInput[] = [];
  let writeCount = 0;
  let prepareCount = 0;
  const fakeModel = options.parentModel ?? model();
  const childFactory: ChildSessionFactory = {
    knownToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    async prepareExtensions(input) {
      calls.push(`prepare-extensions:${input.extensions.join(",")}`);
      prepareCount += 1;
      await options.beforePrepareReturn?.();
      if (
        options.extensionPrepareError ||
        options.extensionPrepareFailures?.includes(prepareCount)
      ) {
        throw new Error("extension loader secret");
      }
      return {
        resourceLoader: {} as any,
        settingsManager: {} as any,
        knownToolNames: [
          "read",
          "bash",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          ...(options.extensionToolNames ?? []),
        ],
        knownSkillNames: options.extensionSkillNames ?? [],
        dispose() {
          calls.push("dispose-preparation");
        },
      };
    },
    async create(input) {
      calls.push("create-child");
      createInputs.push(input);
      await options.beforeCreateReturn?.(input);
      if (options.createError || options.createErrorIds?.includes(input.id)) {
        throw new Error("startup secret");
      }
      return {
        async prompt(prompt, progress) {
          calls.push(`prompt:${prompt}`);
          if (options.promptError) throw new Error("prompt secret");
          if (options.promptImpl) return options.promptImpl(prompt, progress);
          return (
            options.observation ?? {
              output: "done",
              usage: { turns: 1, tool_uses: 0, total_tokens: 12 },
            }
          );
        },
        async configure(configuration) {
          calls.push(
            `configure:${configuration.model ? `${configuration.model.provider}/${configuration.model.id}` : "-"}:${configuration.thinking ?? "-"}`,
          );
          await options.configureImpl?.(configuration);
        },
        async steer(prompt) {
          calls.push(`steer:${prompt}`);
          await options.steerImpl?.(prompt);
        },
        async abort() {
          calls.push("abort");
          await options.abortImpl?.();
        },
        dispose() {
          calls.push("dispose");
        },
      };
    },
  };
  const cleanup = vi.fn(async () => {
    calls.push("cleanup");
    if (options.cleanupError) throw new Error(options.cleanupError);
    return options.cleanupResult;
  });
  const manager = new SessionManager({
    config: {
      historyRetentionDays: 7,
      maxConcurrentSubagents: options.maxConcurrent ?? 8,
      injectGuidelines: true,
    },
    agentDir: "/agent-dir",
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.pi ? { pi: options.pi } : {}),
    registry: {
      snapshot: () => ({ definitions: [], warnings: [] }),
      listCandidates: () => ({ definitions: [], warnings: [] }),
      findForSession: (name) => {
        calls.push(`find:${name}`);
        return name === (options.agent ?? baseAgent).name
          ? (options.agent ?? baseAgent)
          : undefined;
      },
      findCurrent: (name) => {
        calls.push(`find-current:${name}`);
        if (options.currentAgentMissing) return undefined;
        return name === (options.agent ?? baseAgent).name
          ? (options.agent ?? baseAgent)
          : undefined;
      },
    },
    childFactory,
    createStore: () => {
      if (options.createStoreError) throw new Error("store setup secret");
      return (
        options.store ?? {
          async writeSession(snapshot) {
            calls.push(`write:${snapshot.status}`);
            writeCount += 1;
            if (
              writeCount === options.failWrite ||
              options.failWrites?.includes(writeCount)
            ) {
              throw new Error("disk secret");
            }
            await options.writeImpl?.(snapshot, writeCount);
            writes.push(structuredClone(snapshot));
          },
          async loadSessions() {
            return (
              (await options.loadImpl?.()) ?? {
                records: options.loaded ?? [],
                warnings: [],
              }
            );
          },
        }
      );
    },
    cleanup,
    now:
      options.now ??
      (() => {
        let tick = 0;
        return () => `2026-01-01T00:00:0${tick++}.000Z`;
      })(),
    createId: () => {
      calls.push("allocate-id");
      if (options.createIdError) throw new Error("id setup secret");
      return options.createIds?.shift() ?? "00000000-0000-001f";
    },
  });
  const catalog = options.catalog ?? [fakeModel];
  const notify = vi.fn();
  const registry = {
    getAll: () => catalog,
    find: (provider: string, id: string) =>
      catalog.find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      ),
  } as unknown as ModelRegistry;
  const context = {
    cwd: "/project",
    sessionManager: { getSessionId: () => "parent-session" },
    modelRegistry: registry,
    model: fakeModel,
    thinkingLevel: options.parentThinking ?? "medium",
    // notify is always observed so UI-routed diagnostics are assertable;
    // widget-only fusions keep their own setWidget when supplied.
    ui: { notify, ...(options.ui ?? {}) },
  } as unknown as ExtensionContext;
  return { manager, context, calls, writes, createInputs, cleanup, notify };
}

function callNew(
  h: ReturnType<typeof harness>,
  extra: Record<string, unknown> = {},
  context = h.context,
) {
  return h.manager.call(
    { type: "new", agent: "worker", prompt: "  do it  ", ...extra } as never,
    context,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function otherNamespace(h: ReturnType<typeof harness>): ExtensionContext {
  return {
    ...h.context,
    cwd: "/other-project",
    sessionManager: { getSessionId: () => "other-parent" },
  } as unknown as ExtensionContext;
}

describe("background new session", () => {
  it("captures direct registryOptions once until a new manager is constructed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-registry-snapshot-"));
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "work");
      const agentsDir = join(agentDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      const path = join(agentsDir, "worker.md");
      const document = (name: string) =>
        `---\nname: ${name}\ndescription: ${name}.\n---\n# ${name}\nWork.\n`;
      writeFileSync(path, document("alpha"), "utf-8");
      const makeManager = () =>
        new SessionManager({
          config: {
            historyRetentionDays: 7,
            maxConcurrentSubagents: 8,
            injectGuidelines: true,
          },
          agentDir,
          registryOptions: { agentDir, cwd },
        });
      const context = {
        cwd,
        sessionManager: { getSessionId: () => "parent" },
        modelRegistry: { getAll: () => [], find: () => undefined },
        thinkingLevel: "off",
      } as unknown as ExtensionContext;
      const first = makeManager();
      writeFileSync(path, document("beta"), "utf-8");

      await expect(
        first.call({ type: "new", agent: "beta", prompt: "x" }, context),
      ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
      await expect(
        first.call({ type: "new", agent: "alpha", prompt: "x" }, context),
      ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });

      const second = makeManager();
      await expect(
        second.call({ type: "new", agent: "alpha", prompt: "x" }, context),
      ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
      await expect(
        second.call({ type: "new", agent: "beta", prompt: "x" }, context),
      ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is composed into normal activation instead of leaving subagent_call unbound", async () => {
    const tools: ToolDefinition[] = [];
    await extension(
      {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
      } as unknown as ExtensionAPI,
      undefined,
      {
        agentDir: "/tmp/pi-subagents-t2-activation",
        cwd: "/tmp/pi-subagents-t2-project",
      },
    );
    const tool = tools.find((candidate) => candidate.name === "subagent_call");
    const result = await tool!.execute(
      "call",
      { type: "new", agent: "worker", prompt: "   " },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(result.details).toEqual({
      error: { code: "INVALID_ARGUMENT", message: "prompt must be non-empty." },
      __pi_subagents_minimal_ui: { agent: "worker" },
    });
  });

  it("persists queued/running/completed in order and completes in background", async () => {
    const h = harness();
    const accepted = await callNew(h);
    expect(accepted).toMatchObject({
      session_id: "00000000-0000-001f",
      agent: "worker",
      model: "acme/model",
      thinking: "medium",
      status: "queued",
    });
    expect(accepted.warnings).toBeUndefined();
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
        output: "done",
        usage: { turns: 1, tool_uses: 0, total_tokens: 12 },
      });
    });
    expect(h.calls).toEqual([
      "find:worker",
      "allocate-id",
      "prepare-extensions:",
      "write:queued",
      "create-child",
      "write:running",
      "prompt:do it",
      "write:completed",
      "cleanup",
    ]);
    expect(h.writes.map((entry) => entry.status)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
    expect(h.createInputs[0]).toMatchObject({
      id: "00000000-0000-001f",
      cwd: "/project",
      parentSessionId: "parent-session",
      systemPrompt: "You are the child.",
    });
    expect(h.createInputs[0]?.tools).toEqual([]);
    expect(h.createInputs[0]?.skills).toEqual([]);
  });

  it("uses concrete parent capabilities for parent-only thinking resolution", async () => {
    const inherited = harness();
    expect(await callNew(inherited)).toMatchObject({
      thinking: "medium",
      status: "queued",
    });
    await vi.waitFor(() =>
      expect(inherited.createInputs[0]?.thinking).toBe("medium"),
    );

    const explicit = harness();
    expect(await callNew(explicit, { thinking: "high" })).toMatchObject({
      thinking: "high",
      status: "queued",
    });
    await vi.waitFor(() =>
      expect(explicit.createInputs[0]?.thinking).toBe("high"),
    );

    const nonReasoning = harness({
      parentModel: model("basic", "plain", false),
      parentThinking: "medium",
    });
    expect(await callNew(nonReasoning)).toMatchObject({
      model: "basic/plain",
      thinking: "off",
      status: "queued",
    });
    await vi.waitFor(() =>
      expect(nonReasoning.createInputs[0]?.thinking).toBe("off"),
    );
  });

  it("ignores a supplied new-session ID with the exact warning", async () => {
    const accepted = await callNew(harness(), {
      session_id: "00000000-0000-003b",
    });
    expect(accepted.session_id).toBe("00000000-0000-001f");
    expect(accepted.status).toBe("queued");
    expect(accepted.warnings).toEqual([
      {
        code: "SESSION_ID_IGNORED",
        message: 'session_id is ignored when type is "new".',
      },
    ]);
  });

  it("preserves [] as no tools and forwards max_turns", async () => {
    const h = harness({ agent: { ...baseAgent, tools: [], maxTurns: 2 } });
    await callNew(h);
    await vi.waitFor(() => expect(h.createInputs).toHaveLength(1));
    expect(h.createInputs[0]?.tools).toEqual([]);
    expect(h.createInputs[0]?.maxTurns).toBe(2);
  });

  it("loads selected extensions before validating and forwarding extension tools", async () => {
    const agent = {
      ...baseAgent,
      extensions: ["npm:pi-web-access"],
      tools: ["read", "web_search"],
    };
    const h = harness({ agent, extensionToolNames: ["web_search"] });

    await callNew(h);
    expect(h.calls.indexOf("allocate-id")).toBeLessThan(
      h.calls.indexOf("prepare-extensions:npm:pi-web-access"),
    );
    await vi.waitFor(() => expect(h.createInputs).toHaveLength(1));
    expect(h.createInputs[0]?.tools).toEqual(["read", "web_search"]);
    expect(h.createInputs[0]?.extensionPreparation?.knownToolNames).toContain(
      "web_search",
    );
    expect(JSON.stringify(h.writes)).not.toContain("npm:pi-web-access");
    expect(JSON.stringify(h.writes)).not.toContain("web_search");
  });

  it("prepares resources without selecting extensions for omitted or empty metadata", async () => {
    for (const agent of [baseAgent, { ...baseAgent, extensions: [] }]) {
      const h = harness({ agent });
      await callNew(h);
      expect(h.calls).toContain("prepare-extensions:");
    }
  });

  it("fails selected-extension errors and unknown tools after allocation but before mutation", async () => {
    const loadFailure = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      extensionPrepareError: true,
    });
    await expect(callNew(loadFailure)).rejects.toMatchObject({
      code: "EXTENSION_LOAD_FAILED",
      message: 'Agent "worker" extensions could not be loaded.',
    });
    expect(loadFailure.calls).toContain("allocate-id");
    expect(loadFailure.writes).toEqual([]);

    const boundaryFailure = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      extensionPrepareError: true,
    });
    const callTool = createTools({ sessions: boundaryFailure.manager }).find(
      (tool) => tool.name === "subagent_call",
    )!;
    const result = await callTool.execute(
      "call",
      { type: "new", agent: "worker", prompt: "go" },
      undefined,
      undefined,
      boundaryFailure.context,
    );
    expect(result.details).toMatchObject({
      error: {
        code: "EXTENSION_LOAD_FAILED",
        message: 'Agent "worker" extensions could not be loaded.',
      },
    });
    expect(JSON.stringify(result.details)).not.toContain(
      "extension loader secret",
    );

    const unknownTool = harness({
      agent: {
        ...baseAgent,
        extensions: ["npm:pi-web-access"],
        tools: ["web_search"],
      },
    });
    await expect(callNew(unknownTool)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(unknownTool.calls).toContain("prepare-extensions:npm:pi-web-access");
    expect(
      unknownTool.calls.filter((call) => call === "dispose-preparation"),
    ).toHaveLength(1);
    expect(unknownTool.calls).toContain("allocate-id");
  });

  it("blocks shutdown on delayed preparation and disposes before rejecting admission", async () => {
    const preparationGate = deferred<void>();
    const h = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      beforePrepareReturn: () => preparationGate.promise,
    });
    const call = callNew(h);
    await vi.waitFor(() => {
      expect(h.calls).toContain("prepare-extensions:npm:pi-web-access");
    });

    let shutdownSettled = false;
    const shutdown = h.manager.shutdown(h.context).finally(() => {
      shutdownSettled = true;
    });
    await nextTask();
    expect(shutdownSettled).toBe(false);
    preparationGate.resolve();

    await expect(call).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The parent session is shutting down.",
    });
    await shutdown;
    expect(
      h.calls.filter((call) => call === "dispose-preparation"),
    ).toHaveLength(1);
    expect(h.calls).toContain("allocate-id");
    expect(h.writes).toEqual([]);
  });

  it("allocates before preparation and disposes preparation on later setup failure", async () => {
    const idFailure = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      createIdError: true,
    });
    await expect(callNew(idFailure)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "A session ID could not be allocated.",
    });
    expect(idFailure.calls).toEqual(["find:worker", "allocate-id"]);

    const storeFailure = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      createStoreError: true,
    });
    await expect(callNew(storeFailure)).rejects.toBeDefined();
    expect(
      storeFailure.calls.filter((call) => call === "dispose-preparation"),
    ).toHaveLength(1);
    expect(storeFailure.calls).not.toContain("create-child");
    expect(storeFailure.writes).toEqual([]);
  });

  it("retries a process-local collision and accepts the next valid ID unchanged", async () => {
    const existingId = "10000000-0000-0001";
    const nextId = "10000000-0000-0002";
    const h = harness({ createIds: [existingId, existingId, nextId] });

    expect((await callNew(h)).session_id).toBe(existingId);
    expect((await callNew(h)).session_id).toBe(nextId);
    expect(h.calls.filter((call) => call === "allocate-id")).toHaveLength(3);
    expect(h.manager.getSnapshot(existingId)).toBeDefined();
    expect(h.manager.getSnapshot(nextId)).toBeDefined();
  });

  it("reserves IDs across concurrent preparation and retries duplicates", async () => {
    const preparationGate = deferred<void>();
    const firstId = "30000000-0000-0001";
    const secondId = "30000000-0000-0002";
    const h = harness({
      createIds: [firstId, firstId, secondId],
      beforePrepareReturn: () => preparationGate.promise,
    });

    const first = callNew(h);
    await vi.waitFor(() =>
      expect(
        h.calls.filter((call) => call === "prepare-extensions:"),
      ).toHaveLength(1),
    );
    const second = callNew(h);
    await vi.waitFor(() =>
      expect(
        h.calls.filter((call) => call === "prepare-extensions:"),
      ).toHaveLength(2),
    );
    preparationGate.resolve();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { session_id: firstId },
      { session_id: secondId },
    ]);
    expect(h.calls.filter((call) => call === "allocate-id")).toHaveLength(3);
    expect(h.manager.getSnapshot(firstId)).toBeDefined();
    expect(h.manager.getSnapshot(secondId)).toBeDefined();
    expect(
      (
        h.manager as unknown as {
          sessionIdReservations: Map<string, string>;
        }
      ).sessionIdReservations.size,
    ).toBe(0);
  });

  it("releases a reservation when preparation fails", async () => {
    const reusableId = "40000000-0000-0001";
    const h = harness({
      createIds: [reusableId, reusableId],
      extensionPrepareFailures: [1],
    });

    await expect(callNew(h)).rejects.toMatchObject({
      code: "EXTENSION_LOAD_FAILED",
    });
    await expect(callNew(h)).resolves.toMatchObject({
      session_id: reusableId,
    });
    expect(h.calls.filter((call) => call === "allocate-id")).toHaveLength(2);
    expect(
      (
        h.manager as unknown as {
          sessionIdReservations: Map<string, string>;
        }
      ).sessionIdReservations.size,
    ).toBe(0);
  });

  it("rejects invalid generated IDs before preparation or mutation", async () => {
    const h = harness({ createIds: ["ses_legacy"] });

    await expect(callNew(h)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "A session ID could not be allocated.",
    });
    expect(h.calls).toEqual(["find:worker", "allocate-id"]);
    expect(h.writes).toEqual([]);
    expect(h.createInputs).toEqual([]);
    expect(h.manager.sessionStatus()).toEqual({
      active_sessions: [],
      recent_sessions: [],
    });
  });

  it("stops after 16 collisions without preparation or mutation", async () => {
    const existingId = "20000000-0000-0001";
    const notify = vi.fn();
    const h = harness({
      createIds: [existingId, ...Array<string>(16).fill(existingId)],
      notifier: { notify },
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(await h.manager.output({ session_id: existingId })).toMatchObject({
        status: "completed",
      });
    });
    const baseline = {
      calls: h.calls.length,
      writes: h.writes.length,
      children: h.createInputs.length,
      notifications: notify.mock.calls.length,
      status: h.manager.sessionStatus(),
    };

    await expect(callNew(h)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "A session ID could not be allocated.",
    });
    expect(h.calls.slice(baseline.calls)).toEqual([
      "find:worker",
      ...Array<string>(16).fill("allocate-id"),
    ]);
    expect(h.writes).toHaveLength(baseline.writes);
    expect(h.createInputs).toHaveLength(baseline.children);
    expect(notify).toHaveBeenCalledTimes(baseline.notifications);
    expect(h.manager.sessionStatus()).toEqual(baseline.status);
  });

  it("disposes preparation exactly once when child creation fails", async () => {
    const h = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      createError: true,
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "failed" });
    });
    expect(
      h.calls.filter((call) => call === "dispose-preparation"),
    ).toHaveLength(1);
    expect(h.calls.filter((call) => call === "dispose")).toHaveLength(0);
  });

  it("settles max turns as stopped while preserving observed output", async () => {
    const h = harness({
      observation: {
        output: "last answer",
        usage: { turns: 2, tool_uses: 1, total_tokens: 30 },
        maxTurnsReached: true,
      },
    });
    expect(await callNew(h)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "stopped" });
    });
    const result = await h.manager.output({ session_id: "00000000-0000-001f" });
    expect(result).toMatchObject({
      status: "stopped",
      output: "last answer",
      error: {
        code: "MAX_TURNS_REACHED",
        message:
          "The child session reached its configured maximum number of turns.",
      },
    });
  });

  it("maps observed abort and assistant errors without discarding output", async () => {
    const abortedHarness = harness({
      observation: { output: "partial", aborted: true },
    });
    expect(await callNew(abortedHarness)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await abortedHarness.manager.output({
          session_id: "00000000-0000-001f",
        }),
      ).toMatchObject({
        status: "aborted",
        output: "partial",
      });
    });
    const aborted = await abortedHarness.manager.output({
      session_id: "00000000-0000-001f",
    });
    expect(aborted).toMatchObject({ status: "aborted", output: "partial" });

    const failedHarness = harness({
      observation: {
        output: "partial",
        error: { code: "CHILD_EXECUTION_FAILED", message: "safe" },
      },
    });
    expect(await callNew(failedHarness)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await failedHarness.manager.output({
          session_id: "00000000-0000-001f",
        }),
      ).toMatchObject({
        status: "failed",
        output: "partial",
      });
    });
    const failed = await failedHarness.manager.output({
      session_id: "00000000-0000-001f",
    });
    expect(failed).toMatchObject({ status: "failed", output: "partial" });
  });

  it("persists inspectable failure when creation or prompt fails", async () => {
    const startup = harness({ createError: true });
    expect(await callNew(startup)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await startup.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "failed" });
    });
    expect(startup.writes.map((entry) => entry.status)).toEqual([
      "queued",
      "failed",
    ]);

    const prompt = harness({ promptError: true });
    expect(await callNew(prompt)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await prompt.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "failed" });
    });
    expect(prompt.writes.map((entry) => entry.status)).toEqual([
      "queued",
      "running",
      "failed",
    ]);
  });

  it("keeps pre-prompt failures generic and labels prompt network failures neutrally", async () => {
    const startup = harness({
      beforeCreateReturn: async () => {
        throw new Error("401 Unauthorized: invalid API key sk-live-SECRET");
      },
    });
    expect(await callNew(startup)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await startup.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "failed",
        error: {
          code: "CHILD_EXECUTION_FAILED",
          message: "The child session could not be executed.",
        },
      });
    });
    const startupFailure = await startup.manager.output({
      session_id: "00000000-0000-001f",
    });
    expect(JSON.stringify(startupFailure)).not.toContain("sk-live-SECRET");
    expect(JSON.stringify(startupFailure)).not.toContain("Unauthorized");

    const prompt = harness({
      promptImpl: () => Promise.reject(new Error("fetch failed")),
    });
    expect(await callNew(prompt)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await prompt.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "failed",
        error: {
          code: "CHILD_EXECUTION_FAILED",
          message:
            "The child session could not be executed: a network request failed.",
        },
      });
    });

    const unrecognized = harness({
      promptImpl: () =>
        Promise.reject(
          new Error("Authorization: Bearer sk-live-SECRET at /private/file.ts"),
        ),
    });
    expect(await callNew(unrecognized)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await unrecognized.manager.output({
          session_id: "00000000-0000-001f",
        }),
      ).toMatchObject({
        status: "failed",
        error: {
          code: "CHILD_EXECUTION_FAILED",
          message: "The child session could not be executed.",
        },
      });
    });
    const unrecognizedFailure = await unrecognized.manager.output({
      session_id: "00000000-0000-001f",
    });
    expect(JSON.stringify(unrecognizedFailure)).not.toContain("sk-live-SECRET");
  });

  it("persists generic failures for local writes, ambiguous errors, and throwing getters", async () => {
    const storage = harness({
      writeImpl: async (snapshot) => {
        if (snapshot.status === "running") {
          throw new Error("429 rate limit exceeded: sk-live-SECRET");
        }
      },
    });
    await callNew(storage);
    await vi.waitFor(async () => {
      expect(
        await storage.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "failed",
        error: { message: "The child session could not be executed." },
      });
    });
    expect(storage.writes.map((entry) => entry.status)).toEqual([
      "queued",
      "failed",
    ]);

    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("secret proxy getter");
        },
      },
    );
    const startup = harness({
      beforeCreateReturn: async () => {
        throw proxy;
      },
    });
    await callNew(startup);
    await vi.waitFor(async () => {
      expect(
        await startup.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "failed",
        error: { message: "The child session could not be executed." },
      });
    });

    const prompt = harness({ promptImpl: () => Promise.reject(proxy) });
    await callNew(prompt);
    await vi.waitFor(async () => {
      expect(
        await prompt.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "failed",
        error: { message: "The child session could not be executed." },
      });
    });
    expect(prompt.writes.map((entry) => entry.status)).toEqual([
      "queued",
      "running",
      "failed",
    ]);

    const throwingCause = {
      message: "fetch failed",
      get cause(): unknown {
        throw new Error("secret getter");
      },
    };
    const nested = harness({ promptImpl: () => Promise.reject(throwingCause) });
    await callNew(nested);
    await vi.waitFor(async () => {
      expect(
        await nested.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "failed",
        error: { message: "The child session could not be executed." },
      });
    });
  });

  it("returns queued acceptance promptly and identifies the agent only after child creation", async () => {
    const createGate = deferred<void>();
    const promptGate = deferred<ChildExecutionObservation>();
    const identified = vi.fn();
    const h = harness({
      beforeCreateReturn: () => createGate.promise,
      promptImpl: () => promptGate.promise,
    });

    const accepted = await h.manager.call(
      { type: "new", agent: "worker", prompt: "task" },
      h.context,
      { identified },
    );
    expect(accepted).toMatchObject({
      status: "queued",
      session_id: "00000000-0000-001f",
    });
    await vi.waitFor(() => expect(h.calls).toContain("create-child"));
    expect(identified).not.toHaveBeenCalled();

    createGate.resolve(undefined);
    await vi.waitFor(() =>
      expect(identified).toHaveBeenCalledExactlyOnceWith("worker"),
    );

    promptGate.resolve({ output: "done" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
  });

  it("does not identify the agent when child creation fails", async () => {
    const identified = vi.fn();
    const h = harness({ createError: true });
    expect(
      await h.manager.call(
        { type: "new", agent: "worker", prompt: "task" },
        h.context,
        { identified },
      ),
    ).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "failed" });
    });
    expect(identified).not.toHaveBeenCalled();
  });

  it("returns queued resume acceptance promptly and identifies after admission", async () => {
    const resumeGate = deferred<ChildExecutionObservation>();
    let promptCount = 0;
    const h = harness({
      promptImpl: () =>
        ++promptCount === 1
          ? Promise.resolve({ output: "initial" })
          : resumeGate.promise,
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const identified = vi.fn();
    const accepted = await h.manager.call(
      { type: "resume", session_id: "00000000-0000-001f", prompt: "continue" },
      h.context,
      { identified },
    );
    expect(accepted).toMatchObject({
      status: "queued",
      session_id: "00000000-0000-001f",
    });

    await vi.waitFor(() =>
      expect(identified).toHaveBeenCalledExactlyOnceWith("worker"),
    );
    resumeGate.resolve({ output: "resumed" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
        output: "resumed",
      });
    });
  });

  it("validates requests and resolution before allocation, then capabilities before mutation", async () => {
    for (const [h, params] of [
      [harness(), { prompt: "   " }],
      [harness(), { agent: "Worker" }],
      [harness(), { model: "missing" }],
    ] as const) {
      await expect(callNew(h, params)).rejects.toBeDefined();
      expect(h.calls).not.toContain("allocate-id");
      expect(h.writes).toEqual([]);
    }

    const unavailable = harness({
      agent: { ...baseAgent, tools: ["unknown"] },
    });
    await expect(callNew(unavailable)).rejects.toBeDefined();
    expect(unavailable.calls).toContain("allocate-id");
    expect(unavailable.writes).toEqual([]);
  });

  it("lets agent frontmatter outrank a supplied blank call model", async () => {
    const h = harness({ agent: { ...baseAgent, model: "acme/model" } });
    await expect(callNew(h, { model: "   " })).resolves.toMatchObject({
      model: "acme/model",
    });
  });

  it("rejects a supplied blank call model when agent frontmatter is absent", async () => {
    const h = harness();
    await expect(callNew(h, { model: "   " })).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
    expect(h.calls).not.toContain("allocate-id");
  });

  it("does not create a child when initial persistence fails", async () => {
    const h = harness({ failWrite: 1 });
    await expect(callNew(h)).rejects.toBeDefined();
    expect(h.calls).not.toContain("create-child");
  });

  it("keeps terminal state in memory and skips cleanup when terminal persistence fails", async () => {
    const h = harness({ failWrite: 3 });
    expect(await callNew(h)).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(h.manager.getSnapshot("00000000-0000-001f")).toMatchObject({
        status: "completed",
        output: "done",
      });
    });
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(
      "[pi-subagents-minimal] An asynchronous subagent execution did not persist normally.",
      "warning",
    );
  });
});

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("004 process-wide concurrency queue", () => {
  it("caps execution, preserves FIFO, and publishes queued records", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    const pushes: Array<{ sessionId: string; status: string }> = [];
    const h = harness({
      maxConcurrent: 2,
      createIds: [
        "00000000-0000-0006",
        "00000000-0000-000e",
        "00000000-0000-0011",
      ],
      notifier: {
        notify: (signal) => {
          pushes.push({ ...signal });
        },
      },
      promptImpl: (prompt) =>
        new Promise((resolve) => releases.set(prompt, resolve)),
    });

    await callNew(h, { prompt: "one" });
    await callNew(h, { prompt: "two" });
    await callNew(h, { prompt: "three" });
    await nextTask();
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(2);
    expect(
      await h.manager.output({ session_id: "00000000-0000-0011" }),
    ).toMatchObject({
      status: "queued",
    });
    expect(h.manager.sessionStatus().active_sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: "00000000-0000-0011",
          status: "queued",
        }),
      ]),
    );

    releases.get("one")?.({ output: "one done" });
    await nextTask();
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(3);
    expect(h.calls.filter((call) => call.startsWith("prompt:"))).toEqual([
      "prompt:one",
      "prompt:two",
      "prompt:three",
    ]);
    releases.get("two")?.({ output: "two done" });
    releases.get("three")?.({ output: "three done" });
    await nextTask();
    expect(pushes).toHaveLength(3);
    expect(
      pushes.find((signal) => signal.sessionId === "00000000-0000-0011"),
    ).toEqual({
      sessionId: "00000000-0000-0011",
      status: "completed",
    });
    for (const signal of pushes) {
      expect(Object.keys(signal).sort()).toEqual(["sessionId", "status"]);
    }
    expect(
      await h.manager.output({ session_id: "00000000-0000-0011" }),
    ).toMatchObject({
      status: "completed",
      output: "three done",
    });
  });

  it("orders waiting resume and new work by creation time", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    const h = harness({
      maxConcurrent: 1,
      createIds: [
        "00000000-0000-003b",
        "00000000-0000-0023",
        "00000000-0000-0029",
      ],
      promptImpl: (prompt) =>
        prompt === "initial"
          ? Promise.resolve({ output: "ready" })
          : new Promise((resolve) => releases.set(prompt, resolve)),
    });
    await callNew(h, { prompt: "initial" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-003b" }),
      ).toMatchObject({
        status: "completed",
      });
    });
    await callNew(h, { prompt: "holder" });
    await nextTask();
    await h.manager.call(
      { type: "resume", session_id: "00000000-0000-003b", prompt: "resume" },
      h.context,
    );
    await callNew(h, { prompt: "later" });
    releases.get("holder")?.({ output: "released" });
    await nextTask();
    expect(h.calls.filter((call) => call.startsWith("prompt:"))).toEqual([
      "prompt:initial",
      "prompt:holder",
      "prompt:resume",
    ]);
    releases.get("resume")?.({ output: "resumed" });
    await nextTask();
    expect(h.calls.filter((call) => call.startsWith("prompt:")).at(-1)).toBe(
      "prompt:later",
    );
    releases.get("later")?.({ output: "done" });
    await nextTask();
  });

  it("enforces process-wide FIFO across namespaces and breaks equal-time ties by session ID", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    const active = new Set<string>();
    let peak = 0;
    const fixedTime = () => "2026-01-01T00:00:00.000Z";
    const h = harness({
      maxConcurrent: 1,
      now: fixedTime,
      createIds: [
        "00000000-0000-0023",
        "00000000-0000-000e",
        "00000000-0000-0006",
      ],
      promptImpl: (prompt) => {
        active.add(prompt);
        peak = Math.max(peak, active.size);
        return new Promise((resolve) =>
          releases.set(prompt, (value) => {
            active.delete(prompt);
            resolve(value);
          }),
        );
      },
    });
    const other = otherNamespace(h);

    await callNew(h, { prompt: "holder" });
    await nextTask();
    await callNew(h, { prompt: "b" }, h.context);
    await callNew(h, { prompt: "a" }, other);
    releases.get("holder")?.({ output: "done" });
    await nextTask();
    expect(h.calls.filter((call) => call.startsWith("prompt:"))).toEqual([
      "prompt:holder",
      "prompt:a",
    ]);
    releases.get("a")?.({ output: "done" });
    await nextTask();
    expect(h.calls.filter((call) => call.startsWith("prompt:")).at(-1)).toBe(
      "prompt:b",
    );
    expect(peak).toBe(1);
    releases.get("b")?.({ output: "done" });
    await nextTask();
  });

  it("releases slots after child creation, prompt, and running-write failures", async () => {
    const creationGate = deferred<void>();
    const creation = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-000f", "00000000-0000-0033"],
      createErrorIds: ["00000000-0000-000f"],
      beforeCreateReturn: (input) =>
        input.id === "00000000-0000-000f"
          ? creationGate.promise
          : Promise.resolve(),
    });
    await callNew(creation, { prompt: "bad" });
    await callNew(creation, { prompt: "next" });
    creationGate.resolve(undefined);
    await nextTask();
    expect(
      creation.calls.filter((call) => call === "create-child"),
    ).toHaveLength(2);
    expect(
      await creation.manager.output({ session_id: "00000000-0000-000f" }),
    ).toMatchObject({ status: "failed" });

    const promptGate = deferred<ChildExecutionObservation>();
    const prompt = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-000f", "00000000-0000-0033"],
      promptImpl: (value) =>
        value === "bad"
          ? promptGate.promise
          : Promise.resolve({ output: "next" }),
    });
    await callNew(prompt, { prompt: "bad" });
    await nextTask();
    await callNew(prompt, { prompt: "next" });
    promptGate.reject(new Error("prompt failure"));
    await nextTask();
    expect(prompt.calls).toContain("prompt:next");
    expect(
      await prompt.manager.output({ session_id: "00000000-0000-000f" }),
    ).toMatchObject({ status: "failed" });

    const runningGate = deferred<void>();
    const running = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-000f", "00000000-0000-0033"],
      writeImpl: async (snapshot) => {
        if (
          snapshot.session_id === "00000000-0000-000f" &&
          snapshot.status === "running"
        ) {
          await runningGate.promise;
          throw new Error("running write failure");
        }
      },
    });
    await callNew(running, { prompt: "bad" });
    await callNew(running, { prompt: "next" });
    runningGate.resolve(undefined);
    await nextTask();
    expect(
      running.calls.filter((call) => call === "create-child"),
    ).toHaveLength(2);
    expect(
      await running.manager.output({ session_id: "00000000-0000-000f" }),
    ).toMatchObject({ status: "failed" });
  });

  it("does not consume a slot for queued persistence failure and pumps the next waiter", async () => {
    const queuedGate = deferred<void>();
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-000f", "00000000-0000-0033"],
      writeImpl: async (snapshot) => {
        if (
          snapshot.session_id === "00000000-0000-000f" &&
          snapshot.status === "queued"
        ) {
          await queuedGate.promise;
          throw new Error("queued write failure");
        }
      },
    });
    const failed = callNew(h, { prompt: "bad" });
    await Promise.resolve();
    await callNew(h, { prompt: "next" });
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(0);
    queuedGate.resolve(undefined);
    await expect(failed).rejects.toThrow("queued write failure");
    await nextTask();
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(1);
    expect(h.calls).toContain("prompt:next");
  });

  it("queues a background caller while its slot is held and pushes it on settlement", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    const notify = vi.fn();
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-001e", "00000000-0000-0045"],
      notifier: { notify },
      promptImpl: (prompt) =>
        new Promise((resolve) => releases.set(prompt, resolve)),
    });
    expect(await callNew(h, { prompt: "first" })).toMatchObject({
      status: "queued",
    });
    expect(await callNew(h, { prompt: "queued" })).toMatchObject({
      status: "queued",
    });
    await nextTask();
    expect(h.calls).not.toContain("prompt:queued");
    releases.get("first")?.({ output: "first done" });
    await nextTask();
    expect(h.calls).toContain("prompt:queued");
    releases.get("queued")?.({ output: "queued done" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0045" }),
      ).toMatchObject({
        status: "completed",
        output: "queued done",
      });
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("releases a slot when terminal persistence fails", async () => {
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-001d", "00000000-0000-0033"],
      writeImpl: async (snapshot) => {
        if (
          snapshot.session_id === "00000000-0000-001d" &&
          snapshot.status === "completed"
        ) {
          await terminalGate;
          throw new Error("terminal write failed");
        }
      },
    });
    await callNew(h, { prompt: "first" });
    await callNew(h, { prompt: "next" });
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(1);
    releaseTerminal();
    await nextTask();
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(2);
    expect(
      await h.manager.output({ session_id: "00000000-0000-001d" }),
    ).toMatchObject({
      status: "completed",
    });
  });

  it("releases a shutdown slot to a waiter in another namespace", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-0040", "00000000-0000-003e"],
      promptImpl: (prompt) =>
        new Promise((resolve) => releases.set(prompt, resolve)),
      abortImpl: async () => releases.get("owner")?.({ aborted: true }),
    });
    const other = otherNamespace(h);
    await callNew(h, { prompt: "owner" });
    await nextTask();
    await callNew(h, { prompt: "other" }, other);

    await h.manager.shutdown(h.context);
    await nextTask();
    expect(h.calls).toContain("prompt:other");
    expect(
      await h.manager.output({ session_id: "00000000-0000-0040" }),
    ).toMatchObject({
      status: "aborted",
    });
    releases.get("other")?.({ output: "done" });
    await nextTask();
  });

  it("settles queued shutdown work without creating its child and pushes it exactly once", async () => {
    let release!: (value: ChildExecutionObservation) => void;
    const notify = vi.fn();
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-0055", "00000000-0000-0062"],
      notifier: { notify },
      promptImpl: (prompt) =>
        prompt === "first"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve({ output: prompt }),
      abortImpl: async () => release({ aborted: true }),
    });
    await callNew(h, { prompt: "first" });
    await nextTask();
    await callNew(h, { prompt: "waiting" });
    await h.manager.shutdown(h.context);
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(1);
    expect(
      await h.manager.output({ session_id: "00000000-0000-0062" }),
    ).toMatchObject({
      status: "aborted",
      error: { code: "PARENT_SHUTDOWN" },
    });
    const pushedIds = notify.mock.calls.map(([input]) => input.sessionId);
    expect(pushedIds.filter((id) => id === "00000000-0000-0055")).toHaveLength(
      1,
    );
    expect(pushedIds.filter((id) => id === "00000000-0000-0062")).toHaveLength(
      1,
    );
    expect(
      notify.mock.calls.filter(([input]) => input.status === "aborted"),
    ).toHaveLength(2);
  });
});

describe("004 Agents widget integration", () => {
  it("does not mount a new-session row until its gated queued write publishes", async () => {
    const queuedGate = deferred<void>();
    const promptGate = deferred<ChildExecutionObservation>();
    const setWidget = vi.fn();
    const h = harness({
      ui: { setWidget } as unknown as ExtensionContext["ui"],
      writeImpl: (snapshot) =>
        snapshot.status === "queued" ? queuedGate.promise : Promise.resolve(),
      promptImpl: () => promptGate.promise,
    });

    const call = callNew(h, { prompt: "hidden until published" });
    await Promise.resolve();
    expect(setWidget).not.toHaveBeenCalled();
    await expect(
      h.manager.output({ session_id: "00000000-0000-001f" }),
    ).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });

    queuedGate.resolve(undefined);
    await call;
    expect(setWidget).toHaveBeenCalledWith(
      "pi-subagents-minimal:agents",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    promptGate.resolve({ output: "done" });
    await nextTask();
  });

  it("never mounts a new-session row when its queued write rejects", async () => {
    const queuedGate = deferred<void>();
    const setWidget = vi.fn();
    const h = harness({
      ui: { setWidget } as unknown as ExtensionContext["ui"],
      writeImpl: (snapshot) =>
        snapshot.status === "queued" ? queuedGate.promise : Promise.resolve(),
    });

    const call = callNew(h, { prompt: "never published" });
    await Promise.resolve();
    expect(setWidget).not.toHaveBeenCalled();
    queuedGate.reject(new Error("queued write failed"));
    await expect(call).rejects.toThrow("queued write failed");
    expect(setWidget).not.toHaveBeenCalled();
    await expect(
      h.manager.output({ session_id: "00000000-0000-001f" }),
    ).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    expect(h.manager.sessionStatus().active_sessions).toEqual([]);
  });

  it("does not remount a resume row until its gated queued write publishes", async () => {
    vi.useFakeTimers();
    try {
      const queuedGate = deferred<void>();
      const promptGate = deferred<ChildExecutionObservation>();
      const setWidget = vi.fn();
      let current = "2026-01-01T00:00:00.000Z";
      let gateResume = false;
      const h = harness({
        ui: { setWidget } as unknown as ExtensionContext["ui"],
        now: () => current,
        writeImpl: (snapshot) =>
          gateResume && snapshot.status === "queued"
            ? queuedGate.promise
            : Promise.resolve(),
        promptImpl: (prompt) =>
          prompt === "again"
            ? promptGate.promise
            : Promise.resolve({ output: "initial" }),
      });
      await callNew(h);
      await vi.advanceTimersByTimeAsync(0);
      expect(setWidget).toHaveBeenCalledWith(
        "pi-subagents-minimal:agents",
        expect.any(Function),
        { placement: "aboveEditor" },
      );
      setWidget.mockClear();

      // A parent input boundary hides the already-completed row before resume.
      current = "2026-01-01T00:00:10.000Z";
      h.manager.onParentInput(h.context);
      expect(setWidget).toHaveBeenLastCalledWith(
        "pi-subagents-minimal:agents",
        undefined,
      );
      setWidget.mockClear();
      gateResume = true;

      const call = h.manager.call(
        { type: "resume", session_id: "00000000-0000-001f", prompt: "again" },
        h.context,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(setWidget).not.toHaveBeenCalled();
      await expect(
        h.manager.output({ session_id: "00000000-0000-001f" }),
      ).rejects.toMatchObject({
        code: "SESSION_NOT_FOUND",
      });

      queuedGate.resolve(undefined);
      await call;
      expect(setWidget).toHaveBeenCalledWith(
        "pi-subagents-minimal:agents",
        expect.any(Function),
        { placement: "aboveEditor" },
      );
      promptGate.resolve({ output: "resumed" });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["visible", false],
    ["hidden", true],
  ] as const)(
    "restores all prior terminal widget state for a %s row when a resume write rejects",
    async (_visibility, hidden) => {
      const queuedGate = deferred<void>();
      let component: { render(): string[] } | undefined;
      const setWidget = vi.fn((_key: string, factory: unknown) => {
        if (typeof factory === "function") {
          component = (
            factory as (
              tui: { requestRender(): void },
              theme: Theme,
            ) => { render(): string[] }
          )({ requestRender: vi.fn() }, {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          } as Theme);
        }
      });
      let gateResume = false;
      const h = harness({
        observation: {
          output: "done",
          usage: { turns: 4, tool_uses: 0, total_tokens: 89 },
          widgetUsage: { turns: 4, input: 5200, output: 3700 },
        },
        ui: { setWidget } as unknown as ExtensionContext["ui"],
        writeImpl: (snapshot) =>
          gateResume && snapshot.status === "queued"
            ? queuedGate.promise
            : Promise.resolve(),
      });
      await callNew(h, { prompt: "original label" });
      await vi.waitFor(async () => {
        expect(
          await h.manager.output({ session_id: "00000000-0000-001f" }),
        ).toMatchObject({
          status: "completed",
        });
      });
      if (hidden) h.manager.onParentInput(h.context);

      const record = (
        h.manager as unknown as {
          records: Map<string, Record<string, unknown>>;
        }
      ).records.get("00000000-0000-001f")!;
      const restoredKeys = [
        "reserved",
        "execution",
        "settlement",
        "abortRequest",
        "observation",
        "progress",
        "shutdownSignal",
        "forceShutdownSettlement",
        "store",
        "context",
        "activeSnapshot",
        "taskLabel",
        "pushed",
        "published",
        "widgetVisible",
        "readyForAdmission",
        "admissionResolve",
        "admission",
        "holdsSlot",
      ] as const;
      const before = new Map(restoredKeys.map((key) => [key, record[key]]));
      gateResume = true;

      const call = h.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-001f",
          prompt: "replacement label",
        },
        h.context,
      );
      await Promise.resolve();
      queuedGate.reject(new Error("queued write failed"));
      await expect(call).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

      for (const key of restoredKeys) expect(record[key]).toBe(before.get(key));
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
        output: "done",
      });
      if (hidden) {
        expect(setWidget).toHaveBeenLastCalledWith(
          "pi-subagents-minimal:agents",
          undefined,
        );
      } else {
        const rendered = component?.render().join("\n") ?? "";
        expect(rendered).toContain("original label");
        expect(rendered).toContain(
          "acme/model · medium · 4 turns · 5.2k in / 3.7k out",
        );
        expect(rendered).not.toContain("replacement label");
        h.manager.onParentInput(h.context);
      }
    },
  );

  it("tracks background work across mixed TUI availability and clears its ticker", async () => {
    vi.useFakeTimers();
    try {
      const releases = new Map<
        string,
        (value: ChildExecutionObservation) => void
      >();
      const requestRender = vi.fn();
      let component: { render(): string[] } | undefined;
      const setWidget = vi.fn((_key: string, factory: unknown) => {
        if (typeof factory === "function") {
          component = (
            factory as (
              tui: { requestRender(): void },
              theme: Theme,
            ) => { render(): string[] }
          )({ requestRender }, {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          } as Theme);
        }
      });
      const h = harness({
        maxConcurrent: 1,
        createIds: ["00000000-0000-001e", "00000000-0000-0053"],
        ui: { setWidget } as unknown as ExtensionContext["ui"],
        promptImpl: (prompt) =>
          new Promise((resolve) => releases.set(prompt, resolve)),
      });
      const withoutTui = {
        ...h.context,
        ui: undefined,
      } as unknown as ExtensionContext;

      expect(await callNew(h, { prompt: "first task" })).toMatchObject({
        status: "queued",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(setWidget).toHaveBeenCalledWith(
        "pi-subagents-minimal:agents",
        expect.any(Function),
        { placement: "aboveEditor" },
      );
      expect(component?.render().join("\n")).toContain("first task");

      expect(
        await callNew(h, { prompt: "second task" }, withoutTui),
      ).toMatchObject({ status: "queued" });
      releases.get("first task")?.({ output: "first done" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(async () => {
        expect(
          await h.manager.output({ session_id: "00000000-0000-001e" }),
        ).toMatchObject({
          status: "completed",
        });
      });
      expect(component?.render().join("\n")).toContain("second task");

      const rendersBeforeTick = requestRender.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(requestRender.mock.calls.length).toBeGreaterThan(
        rendersBeforeTick,
      );

      releases.get("second task")?.({ output: "second done" });
      await vi.advanceTimersByTimeAsync(0);
      h.manager.onParentInput(h.context);
      expect(setWidget).toHaveBeenLastCalledWith(
        "pi-subagents-minimal:agents",
        undefined,
      );
      const rendersAfterDispose = requestRender.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(requestRender).toHaveBeenCalledTimes(rendersAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminal row input-boundary visibility", () => {
  function viewHarness(
    options: {
      promptImpl?: (prompt: string) => Promise<ChildExecutionObservation>;
      createIds?: string[];
    } = {},
  ) {
    let component: { render(): string[] } | undefined;
    const requestRender = vi.fn();
    const setWidget = vi.fn((_key: string, factory: unknown) => {
      if (typeof factory === "function") {
        component = (
          factory as (
            tui: { requestRender(): void },
            theme: Theme,
          ) => { render(): string[] }
        )({ requestRender }, {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as Theme);
      }
    });
    const h = harness({
      ...(options.promptImpl ? { promptImpl: options.promptImpl } : {}),
      ...(options.createIds ? { createIds: options.createIds } : {}),
      ui: { setWidget } as unknown as ExtensionContext["ui"],
      now: () => "2026-01-01T00:00:00.000Z",
    });
    return { ...h, component: () => component, requestRender, setWidget };
  }

  it("keeps terminal output until the next parent input, without a linger timer", async () => {
    vi.useFakeTimers();
    try {
      const h = viewHarness();
      await callNew(h, { prompt: "finished task" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.component()?.render().join("\n")).toContain(
        "✓ worker · finished task",
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.component()?.render().join("\n")).toContain("finished task");
      h.manager.onParentInput(h.context);
      expect(h.setWidget).toHaveBeenLastCalledWith(
        "pi-subagents-minimal:agents",
        undefined,
      );
      const renders = h.requestRender.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.requestRender).toHaveBeenCalledTimes(renders);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides only rows terminal at the boundary and preserves later settlement", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    const h = viewHarness({
      createIds: ["00000000-0000-0017", "00000000-0000-0050"],
      promptImpl: (prompt) =>
        new Promise((resolve) => releases.set(prompt, resolve)),
    });
    await callNew(h, { prompt: "done first" });
    await callNew(h, { prompt: "still running" });
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get("done first")?.({ output: "done" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0017" }),
      ).toMatchObject({
        status: "completed",
      });
    });

    h.manager.onParentInput(h.context);
    let rendered = h.component()?.render().join("\n") ?? "";
    expect(rendered).not.toContain("done first");
    expect(rendered).toContain("still running");

    releases.get("still running")?.({ output: "later" });
    await nextTask();
    rendered = h.component()?.render().join("\n") ?? "";
    expect(rendered).toContain("✓ worker · still running");
    h.manager.onParentInput(h.context);
    expect(h.setWidget).toHaveBeenLastCalledWith(
      "pi-subagents-minimal:agents",
      undefined,
    );
  });

  it("applies input boundaries only to their parent namespace", async () => {
    const h = viewHarness({
      createIds: ["00000000-0000-0006", "00000000-0000-000e"],
    });
    const other = {
      ...h.context,
      sessionManager: { getSessionId: () => "other-parent" },
    } as unknown as ExtensionContext;
    await callNew(h, { prompt: "parent A" });
    await callNew(h, { prompt: "parent B" }, other);
    await nextTask();

    h.manager.onParentInput(h.context);
    expect(
      await h.manager.output({ session_id: "00000000-0000-000e" }),
    ).toMatchObject({
      status: "completed",
    });
    expect(
      (h.manager as unknown as { views: Map<string, unknown> }).views.size,
    ).toBe(1);
    h.manager.onParentInput(other);
    expect(
      (h.manager as unknown as { views: Map<string, unknown> }).views.size,
    ).toBe(0);
  });
});

describe("background terminal push", () => {
  it.each([
    ["completed", { output: "done" }],
    [
      "failed",
      { output: "partial", error: { code: "CHILD_ERROR", message: "failed" } },
    ],
    ["stopped", { output: "partial", maxTurnsReached: true }],
    ["aborted", { output: "partial", aborted: true }],
  ] as const)(
    "pushes natural %s settlement exactly once",
    async (status, observation) => {
      const notify = vi.fn();
      const h = harness({ observation, notifier: { notify } });
      await callNew(h, {});
      await nextTask();

      expect(notify).toHaveBeenCalledOnce();
      expect(notify.mock.calls[0]?.[0]).toEqual({
        sessionId: "00000000-0000-001f",
        status,
      });
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status,
        ...(status === "aborted" ? { error: { code: "CHILD_ABORTED" } } : {}),
      });
    },
  );

  it("keeps notifier rejection warn-only after terminal publication", async () => {
    const h = harness({
      notifier: {
        notify: async () => {
          throw new Error("notify secret");
        },
      },
    });
    await callNew(h, {});
    await nextTask();

    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "completed",
      output: "done",
    });
    expect(h.notify).toHaveBeenCalledExactlyOnceWith(
      "[pi-subagents-minimal] Could not deliver an asynchronous subagent completion.",
      "warning",
    );
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain("secret");
  });
});

describe("background output and session status", () => {
  it("returns the immutable queued acceptance while execution progresses", async () => {
    let release!: (value: ChildExecutionObservation) => void;
    const gate = new Promise<ChildExecutionObservation>((resolve) => {
      release = resolve;
    });
    let report: ((observation: ChildExecutionObservation) => void) | undefined;
    const h = harness({
      promptImpl: async (_prompt, progress) => {
        report = progress;
        return gate;
      },
    });

    const accepted = await callNew(h, { session_id: "00000000-0000-0025" });
    expect(accepted).toEqual({
      session_id: "00000000-0000-001f",
      agent: "worker",
      model: "acme/model",
      thinking: "medium",
      status: "queued",
      created_at: "2026-01-01T00:00:00.000Z",
      warnings: [
        {
          code: "SESSION_ID_IGNORED",
          message: 'session_id is ignored when type is "new".',
        },
      ],
    });
    expect(
      (await h.manager.output({ session_id: "00000000-0000-001f" })) as object,
    ).toMatchObject({
      status: "queued",
    });
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "running",
    });

    report?.({
      output: "partial",
      usage: { turns: 1, tool_uses: 2, total_tokens: 9 },
    });
    await nextTask();
    const first = await h.manager.output({ session_id: "00000000-0000-001f" });
    const second = await h.manager.output({ session_id: "00000000-0000-001f" });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "running", output: "partial" });
    expect(first).not.toHaveProperty("created_at");

    release({
      output: "done",
      usage: { turns: 2, tool_uses: 2, total_tokens: 15 },
    });
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "completed",
      output: "done",
    });
    expect(h.writes.map((entry) => entry.status)).toEqual([
      "queued",
      "running",
      "running",
      "completed",
    ]);
  });

  it("refreshes confirmed widget stats immediately while progress persistence is blocked", async () => {
    const progressWrite = deferred<void>();
    const progressStarted = deferred<void>();
    const promptDone = deferred<ChildExecutionObservation>();
    let report: ((observation: ChildExecutionObservation) => void) | undefined;
    let component: { render(): string[] } | undefined;
    const setWidget = vi.fn((_key: string, factory: unknown) => {
      if (typeof factory === "function") {
        component = (
          factory as (
            tui: { requestRender(): void },
            theme: Theme,
          ) => { render(): string[] }
        )({ requestRender: vi.fn() }, {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as Theme);
      }
    });
    const h = harness({
      ui: { setWidget } as unknown as ExtensionContext["ui"],
      writeImpl: async (_snapshot, count) => {
        if (count === 3) {
          progressStarted.resolve(undefined);
          await progressWrite.promise;
        }
      },
      promptImpl: async (_prompt, progress) => {
        report = progress;
        return promptDone.promise;
      },
    });

    await callNew(h, {});
    await vi.waitFor(() => expect(report).toBeDefined());
    report?.({
      output: "settled turn one",
      usage: { turns: 1, tool_uses: 0, total_tokens: 15 },
      widgetUsage: { turns: 1, input: 3100, output: 2400 },
    });
    await progressStarted.promise;

    expect(component?.render().join("\n")).toContain(
      "acme/model · medium · 1 turns · 3.1k in / 2.4k out",
    );
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "running",
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).not.toHaveProperty("output");

    // No settlement callback arrives for the in-progress next turn, so the
    // last confirmed values remain visible while persistence is still blocked.
    await nextTask();
    expect(component?.render().join("\n")).toContain(
      "acme/model · medium · 1 turns · 3.1k in / 2.4k out",
    );

    progressWrite.resolve(undefined);
    promptDone.resolve({
      output: "done",
      usage: { turns: 2, tool_uses: 0, total_tokens: 30 },
      widgetUsage: { turns: 2, input: 5000, output: 4000 },
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
      });
    });
    h.manager.onParentInput(h.context);
  });

  it("keeps confirmed widget stats visible when progress persistence rejects", async () => {
    const rejectProgress = deferred<void>();
    const progressStarted = deferred<void>();
    const promptDone = deferred<ChildExecutionObservation>();
    let report: ((observation: ChildExecutionObservation) => void) | undefined;
    let component: { render(): string[] } | undefined;
    const setWidget = vi.fn((_key: string, factory: unknown) => {
      if (typeof factory === "function") {
        component = (
          factory as (
            tui: { requestRender(): void },
            theme: Theme,
          ) => { render(): string[] }
        )({ requestRender: vi.fn() }, {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as Theme);
      }
    });
    const h = harness({
      ui: { setWidget } as unknown as ExtensionContext["ui"],
      writeImpl: async (_snapshot, count) => {
        if (count === 3) {
          progressStarted.resolve(undefined);
          await rejectProgress.promise;
        }
      },
      promptImpl: async (_prompt, progress) => {
        report = progress;
        return promptDone.promise;
      },
    });

    await callNew(h, {});
    await vi.waitFor(() => expect(report).toBeDefined());
    report?.({
      output: "unpublished partial",
      usage: { turns: 1, tool_uses: 0, total_tokens: 12 },
      widgetUsage: { turns: 1, input: 2800, output: 4100 },
    });
    await progressStarted.promise;

    // Process-local confirmed usage is visible before the write settles, while
    // the public projection still reflects the previously published snapshot.
    expect(component?.render().join("\n")).toContain(
      "acme/model · medium · 1 turns · 2.8k in / 4.1k out",
    );
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "running",
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).not.toHaveProperty("output");

    rejectProgress.reject(new Error("progress write failed"));
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        "[pi-subagents-minimal] Skipped a subagent progress snapshot persistence refresh.",
        "warning",
      );
    });
    expect(component?.render().join("\n")).toContain(
      "acme/model · medium · 1 turns · 2.8k in / 4.1k out",
    );
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).not.toHaveProperty("output");

    // The next turn is in progress but has not settled, so the last confirmed
    // widget snapshot must remain coherent after the rejected write.
    await nextTask();
    expect(component?.render().join("\n")).toContain(
      "acme/model · medium · 1 turns · 2.8k in / 4.1k out",
    );
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).not.toHaveProperty("output");

    promptDone.resolve({
      output: "done",
      usage: { turns: 2, tool_uses: 0, total_tokens: 24 },
      widgetUsage: { turns: 2, input: 3900, output: 5200 },
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
        output: "done",
      });
    });
    h.manager.onParentInput(h.context);
  });

  it("owns concurrent background executions without a global session limit", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    const h = harness({
      createIds: ["00000000-0000-003c", "00000000-0000-005d"],
      promptImpl: (prompt) =>
        new Promise((resolve) => {
          releases.set(prompt, resolve);
        }),
    });
    const one = await callNew(h, { prompt: "one" });
    const two = await callNew(h, { prompt: "two" });
    expect([one.session_id, two.session_id]).toEqual([
      "00000000-0000-003c",
      "00000000-0000-005d",
    ]);
    await nextTask();
    expect(h.manager.sessionStatus().active_sessions).toHaveLength(2);
    releases.get("one")?.({ output: "one" });
    releases.get("two")?.({ output: "two" });
    await nextTask();
    expect(h.manager.sessionStatus().recent_sessions).toHaveLength(2);
  });

  it("keeps background terminal state local and emits one redacted operational warning", async () => {
    const h = harness({ failWrite: 3 });
    await callNew(h, {});
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "completed",
      output: "done",
    });
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]?.[0]).toBe(
      "[pi-subagents-minimal] An asynchronous subagent execution did not persist normally.",
    );
  });

  it("uses SESSION_NOT_FOUND for malformed and unknown IDs", async () => {
    const h = harness();
    for (const session_id of [
      "bad",
      "wf_one",
      "ses_legacy",
      "00000000-0000-005e",
    ]) {
      await expect(h.manager.output({ session_id })).rejects.toMatchObject({
        code: "SESSION_NOT_FOUND",
      });
    }
  });

  it("emits one fixed diagnostic for returned cleanup warnings", async () => {
    const secret = "cleanup-warning-secret";
    const h = harness({
      cleanupResult: {
        deletedPaths: [],
        deletedCount: 0,
        warnings: [{ path: `/safe/${secret}`, message: `Skipped ${secret}.` }],
      },
    });

    await callNew(h);
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledExactlyOnceWith(
        RETENTION_CLEANUP_RESULT_WARNING,
        "warning",
      );
    });
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain(secret);
  });

  it("evicts retained terminal records reported deleted by cleanup", async () => {
    const old: PersistedSessionSnapshot = {
      session_id: "00000000-0000-003b",
      agent: "worker",
      model: "acme/model",
      thinking: "off",
      status: "completed",
      created_at: "2025-01-01T00:00:00.000Z",
      completed_at: "2025-01-01T00:00:01.000Z",
    };
    const h = harness({
      loaded: [old],
      cleanupResult: {
        deletedPaths: [
          sessionRecordPath({
            agentDir: "/agent-dir",
            projectPath: "/project",
            parentSessionId: "parent-session",
            sessionId: "00000000-0000-003b",
          }),
        ],
        deletedCount: 1,
        warnings: [],
      },
    });
    await h.manager.load(h.context);
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
      });
    });
    await expect(
      h.manager.output({ session_id: "00000000-0000-003b" }),
    ).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("skips loaded IDs already owned by another namespace", async () => {
    const sessionId = "50000000-0000-0001";
    const snapshot: PersistedSessionSnapshot = {
      session_id: sessionId,
      agent: "worker",
      model: "acme/model",
      thinking: "off",
      status: "completed",
      created_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:01.000Z",
    };
    const h = harness({ loaded: [snapshot] });
    const other = otherNamespace(h);

    await h.manager.load(h.context);
    await h.manager.load(other);

    const collidingPath = sessionRecordPath({
      agentDir: "/agent-dir",
      projectPath: other.cwd,
      parentSessionId: other.sessionManager.getSessionId(),
      sessionId,
    });
    expect(h.notify).toHaveBeenCalledExactlyOnceWith(
      `[pi-subagents-minimal] ${collidingPath}: ${LOAD_SESSION_ID_COLLISION_WARNING}`,
      "warning",
    );
    await expect(
      h.manager.call(
        { type: "resume", session_id: sessionId, prompt: "continue" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE" });
    await expect(
      h.manager.call(
        { type: "resume", session_id: sessionId, prompt: "continue" },
        other,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(h.manager.getSnapshot(sessionId)).toEqual(snapshot);
  });

  it("replaces an unchanged pre-load namespace snapshot", async () => {
    const sessionId = "60000000-0000-0000";
    const loaded: PersistedSessionSnapshot[] = [
      {
        session_id: sessionId,
        agent: "worker",
        model: "acme/model",
        thinking: "off",
        status: "completed",
        created_at: "2025-01-01T00:00:00.000Z",
        completed_at: "2025-01-01T00:00:01.000Z",
        output: "first stored output",
      },
    ];
    const h = harness({ loaded });

    await h.manager.load(h.context);
    loaded[0] = { ...loaded[0]!, output: "replacement stored output" };
    await h.manager.load(h.context);

    expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
      status: "completed",
      output: "replacement stored output",
    });
  });

  it("preserves a reservation transferred to a live record while loading", async () => {
    const sessionId = "60000000-0000-0001";
    const loadGate = deferred<{
      records: PersistedSessionSnapshot[];
      warnings: [];
    }>();
    const promptGate = deferred<ChildExecutionObservation>();
    const loadImpl = vi.fn(() => loadGate.promise);
    const h = harness({
      createIds: [sessionId],
      loadImpl,
      promptImpl: () => promptGate.promise,
    });
    const stale: PersistedSessionSnapshot = {
      session_id: sessionId,
      agent: "worker",
      model: "acme/model",
      thinking: "off",
      status: "completed",
      created_at: "2025-01-01T00:00:00.000Z",
      completed_at: "2025-01-01T00:00:01.000Z",
      output: "stale loaded output",
    };

    const loading = h.manager.load(h.context);
    await vi.waitFor(() => expect(loadImpl).toHaveBeenCalledOnce());
    await callNew(h);
    await vi.waitFor(async () => {
      expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
        status: "running",
      });
    });

    loadGate.resolve({ records: [stale], warnings: [] });
    await loading;
    expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
      status: "running",
    });
    expect(h.manager.sessionStatus().active_sessions).toEqual([
      expect.objectContaining({ session_id: sessionId, status: "running" }),
    ]);

    promptGate.resolve({ output: "live output" });
    await vi.waitFor(async () => {
      expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
        status: "completed",
        output: "live output",
      });
    });
    expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
      status: "completed",
      output: "live output",
    });
    await h.manager.shutdown(h.context);
    expect(h.manager.getSnapshot(sessionId)).toMatchObject({
      status: "completed",
      output: "live output",
    });
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0]?.[0]).toContain(
      LOAD_SESSION_ID_COLLISION_WARNING,
    );
  });

  it("preserves an existing record resumed while loading", async () => {
    const sessionId = "60000000-0000-0002";
    const loadGate = deferred<{
      records: PersistedSessionSnapshot[];
      warnings: [];
    }>();
    const resumeGate = deferred<ChildExecutionObservation>();
    const loadImpl = vi.fn(() => loadGate.promise);
    let promptCount = 0;
    const h = harness({
      createIds: [sessionId],
      loadImpl,
      promptImpl: () => {
        promptCount += 1;
        return promptCount === 1
          ? Promise.resolve({ output: "initial output" })
          : resumeGate.promise;
      },
    });

    await callNew(h);
    await vi.waitFor(async () => {
      expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
        status: "completed",
        output: "initial output",
      });
    });
    const stale = h.manager.getSnapshot(sessionId)!;
    const loading = h.manager.load(h.context);
    await vi.waitFor(() => expect(loadImpl).toHaveBeenCalledOnce());
    await h.manager.call(
      { type: "resume", session_id: sessionId, prompt: "continue" },
      h.context,
    );
    await vi.waitFor(async () => {
      expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
        status: "running",
      });
    });

    loadGate.resolve({ records: [stale], warnings: [] });
    await loading;
    expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
      status: "running",
    });

    resumeGate.resolve({ output: "resumed live output" });
    await vi.waitFor(async () => {
      expect(await h.manager.output({ session_id: sessionId })).toMatchObject({
        status: "completed",
        output: "resumed live output",
      });
    });
    await h.manager.shutdown(h.context);
    expect(h.manager.getSnapshot(sessionId)).toMatchObject({
      status: "completed",
      output: "resumed live output",
    });
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0]?.[0]).toContain(
      LOAD_SESSION_ID_COLLISION_WARNING,
    );
  });

  it("orders active summaries by effective start", async () => {
    const h = harness({
      loaded: [
        {
          session_id: "00000000-0000-000e",
          agent: "worker",
          model: "acme/model",
          thinking: "off",
          status: "queued",
          created_at: "2026-01-02T00:00:00.000Z",
        },
        {
          session_id: "00000000-0000-0006",
          agent: "worker",
          model: "acme/model",
          thinking: "off",
          status: "running",
          created_at: "2026-01-01T00:00:00.000Z",
          started_at: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    await h.manager.load(h.context);
    expect(h.manager.sessionStatus()).toEqual({
      active_sessions: [
        {
          session_id: "00000000-0000-000e",
          agent: "worker",
          status: "queued",
          started_at: "2026-01-02T00:00:00.000Z",
        },
        {
          session_id: "00000000-0000-0006",
          agent: "worker",
          status: "running",
          started_at: "2026-01-03T00:00:00.000Z",
        },
      ],
      recent_sessions: [],
    });
  });

  it("loads a parent namespace and reports summary-only ordered status", async () => {
    const h = harness({
      loaded: [
        {
          session_id: "00000000-0000-000e",
          agent: "worker",
          model: "acme/model",
          thinking: "off",
          status: "completed",
          created_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-03T00:00:00.000Z",
          output: "secret",
        },
        {
          session_id: "00000000-0000-0006",
          agent: "worker",
          model: "acme/model",
          thinking: "off",
          status: "aborted",
          created_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-03T00:00:00.000Z",
          error: { code: "RESTART_INTERRUPTED", message: "safe" },
        },
      ],
    });
    await h.manager.load(h.context);
    expect(h.manager.sessionStatus()).toEqual({
      active_sessions: [],
      recent_sessions: [
        {
          session_id: "00000000-0000-0006",
          agent: "worker",
          status: "aborted",
          completed_at: "2026-01-03T00:00:00.000Z",
        },
        {
          session_id: "00000000-0000-000e",
          agent: "worker",
          status: "completed",
          completed_at: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-000e" }),
    ).toMatchObject({
      output: "secret",
    });
  });
});

describe("resume and steer", () => {
  it("resumes a retained child with fresh turn-local snapshots", async () => {
    let turn = 0;
    const h = harness({
      promptImpl: async () => ({
        output: `turn ${++turn}`,
        usage: { turns: turn, tool_uses: 0, total_tokens: turn * 10 },
      }),
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const accepted = await h.manager.call(
      { type: "resume", session_id: "00000000-0000-001f", prompt: "  again  " },
      h.context,
    );
    expect(accepted).toMatchObject({
      session_id: "00000000-0000-001f",
      status: "queued",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
        output: "turn 2",
      });
    });
    const result = await h.manager.output({ session_id: "00000000-0000-001f" });
    expect(result).toMatchObject({
      session_id: "00000000-0000-001f",
      status: "completed",
      output: "turn 2",
    });
    expect(h.calls.filter((entry) => entry === "create-child")).toHaveLength(1);
    expect(h.calls).toContain("find-current:worker");
    expect(
      h.calls.filter((entry) => entry.startsWith("configure:")),
    ).toHaveLength(0);
    expect(h.calls).toContain("prompt:again");
    expect(h.writes.slice(3).map((entry) => entry.status)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
    expect(h.writes[3]).not.toHaveProperty("output");
    expect(h.writes[3]).not.toHaveProperty("started_at");
    expect(h.writes[3]).not.toHaveProperty("completed_at");
  });

  it("re-resolves resume model and thinking from current call and parent layers", async () => {
    const original = model();
    const replacement = model("other", "replacement");
    const h = harness({
      parentModel: original,
      catalog: [original, replacement],
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });

    const modelAccepted = await h.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "switch",
        model: "replacement",
      },
      h.context,
    );
    expect(modelAccepted).toMatchObject({
      model: "other/replacement",
      thinking: "medium",
      status: "queued",
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        model: "other/replacement",
        thinking: "medium",
        status: "completed",
      });
    });
    expect(h.calls).toContain("configure:other/replacement:medium");
    expect(h.calls.indexOf("write:queued")).toBeLessThan(
      h.calls.indexOf("configure:other/replacement:medium"),
    );
    expect(h.calls.indexOf("configure:other/replacement:medium")).toBeLessThan(
      h.calls.lastIndexOf("write:running"),
    );

    const thinkingAccepted = await h.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "deeper",
        thinking: "high",
      },
      h.context,
    );
    expect(thinkingAccepted).toMatchObject({
      model: "acme/model",
      thinking: "high",
      status: "queued",
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        model: "acme/model",
        thinking: "high",
        status: "completed",
      });
    });
    expect(h.calls).toContain("configure:acme/model:high");

    const retained = await h.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "re-resolve",
      },
      h.context,
    );
    expect(retained).toMatchObject({ model: "acme/model", thinking: "medium" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    expect(h.calls.filter((entry) => entry.startsWith("configure:"))).toEqual([
      "configure:other/replacement:medium",
      "configure:acme/model:high",
      "configure:-:medium",
    ]);
  });

  it("uses current injected-registry metadata on resume above call parameters", async () => {
    const original = model();
    const frontmatterModel = model("agent", "preferred");
    const callModel = model("call", "ignored");
    const agent = { ...baseAgent };
    const h = harness({
      agent,
      parentModel: original,
      catalog: [original, frontmatterModel, callModel],
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });

    agent.model = "agent/preferred";
    agent.thinking = "high";
    agent.enabled = false;
    const accepted = await h.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "current metadata wins",
        model: "call/ignored",
        thinking: "low",
      },
      h.context,
    );
    expect(accepted).toMatchObject({
      model: "agent/preferred",
      thinking: "high",
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
        model: "agent/preferred",
        thinking: "high",
      });
    });
    expect(h.calls).toContain("find-current:worker");
    expect(h.calls).toContain("configure:agent/preferred:high");
    expect(h.calls.filter((entry) => entry === "create-child")).toHaveLength(1);
  });

  it("falls through when the injected registry has no current agent metadata", async () => {
    const original = model();
    const callModel = model("call", "selected");
    const h = harness({
      currentAgentMissing: true,
      parentModel: original,
      catalog: [original, callModel],
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });

    const accepted = await h.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "fallback",
        model: "call/selected",
        thinking: "low",
      },
      h.context,
    );
    expect(accepted).toMatchObject({ model: "call/selected", thinking: "low" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
  });

  it("validates resume overrides before mutation and terminalizes configure failures", async () => {
    const original = model();
    const basic = model("basic", "plain", false);
    const h = harness({ parentModel: original, catalog: [original, basic] });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const writesBefore = h.writes.length;
    await expect(
      h.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-001f",
          prompt: "bad",
          model: "basic/plain",
          thinking: "high",
        },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "THINKING_LEVEL_UNSUPPORTED" });
    expect(h.writes).toHaveLength(writesBefore);
    expect(
      h.calls.filter((entry) => entry.startsWith("configure:")),
    ).toHaveLength(0);

    const failing = harness({
      parentModel: original,
      catalog: [original],
      configureImpl: async () => {
        throw new Error("429 rate limit exceeded: sk-live-SECRET");
      },
    });
    await callNew(failing);
    await vi.waitFor(async () => {
      expect(
        await failing.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const accepted = await failing.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "change",
        thinking: "high",
      },
      failing.context,
    );
    expect(accepted).toMatchObject({ status: "queued", thinking: "high" });
    await vi.waitFor(async () => {
      expect(
        await failing.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "failed",
        thinking: "high",
        error: { message: "The child session could not be executed." },
      });
    });
    expect(failing.calls).toContain("configure:-:high");
    expect(
      failing.calls.filter((entry) => entry.startsWith("prompt:")),
    ).toEqual(["prompt:do it"]);
    expect(failing.calls.filter((entry) => entry === "dispose")).toHaveLength(
      1,
    );
    await expect(
      failing.manager.call(
        { type: "resume", session_id: "00000000-0000-001f", prompt: "retry" },
        failing.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE" });
  });

  it("reuses the prepared child and ignores changed capabilities on resume", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      extensions: ["npm:pi-web-access"],
      tools: ["web_search"],
      skills: ["review"],
    };
    const h = harness({
      agent,
      extensionToolNames: ["web_search"],
      extensionSkillNames: ["review"],
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    agent.extensions = ["npm:different-extension"];
    agent.tools = ["different_tool"];
    agent.skills = ["different_skill"];

    await h.manager.call(
      { type: "resume", session_id: "00000000-0000-001f", prompt: "again" },
      h.context,
    );
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    expect(
      h.calls.filter((entry) => entry.startsWith("prepare-extensions:")),
    ).toEqual(["prepare-extensions:npm:pi-web-access"]);
    expect(h.calls.filter((entry) => entry === "create-child")).toHaveLength(1);
  });

  it("reserves before the queued write and returns immutable background acceptance", async () => {
    let invocation = 0;
    let release!: (value: ChildExecutionObservation) => void;
    const h = harness({
      promptImpl: async () => {
        invocation += 1;
        if (invocation === 1) return { output: "first" };
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const first = h.manager.call(
      { type: "resume", session_id: "00000000-0000-001f", prompt: "again" },
      h.context,
    );
    await expect(
      h.manager.call(
        { type: "resume", session_id: "00000000-0000-001f", prompt: "race" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(await first).toEqual({
      session_id: "00000000-0000-001f",
      agent: "worker",
      model: "acme/model",
      thinking: "medium",
      status: "queued",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    release({ output: "second" });
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "completed",
      output: "second",
    });
  });

  it("preserves terminal state on queued failure and terminalizes a running-write failure", async () => {
    const queued = harness({ failWrite: 4 });
    await callNew(queued);
    await vi.waitFor(async () => {
      expect(
        await queued.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    await expect(
      queued.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-001f",
          prompt: "again",
          thinking: "high",
        },
        queued.context,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(
      queued.calls.filter((entry) => entry.startsWith("configure:")),
    ).toHaveLength(0);
    expect(queued.manager.getSnapshot("00000000-0000-001f")).toMatchObject({
      status: "completed",
      output: "done",
    });
    expect(
      await queued.manager.call(
        { type: "resume", session_id: "00000000-0000-001f", prompt: "retry" },
        queued.context,
      ),
    ).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await queued.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({
        status: "completed",
        output: "done",
      });
    });

    const running = harness({ failWrite: 5 });
    await callNew(running);
    await vi.waitFor(async () => {
      expect(
        await running.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const accepted = await running.manager.call(
      { type: "resume", session_id: "00000000-0000-001f", prompt: "again" },
      running.context,
    );
    expect(accepted).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await running.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "failed" });
    });
    expect(
      running.calls.filter((entry) => entry.startsWith("prompt:")),
    ).toEqual(["prompt:do it"]);
    expect(running.writes.at(-1)?.status).toBe("failed");
  });

  it("applies validation order without disclosing other namespaces", async () => {
    const queued: PersistedSessionSnapshot = {
      session_id: "00000000-0000-0045",
      agent: "worker",
      model: "acme/model",
      thinking: "off",
      status: "queued",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const h = harness({ loaded: [queued] });
    await h.manager.load(h.context);
    await expect(
      h.manager.call(
        { type: "resume", session_id: "00000000-0000-0045", prompt: "x" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await expect(
      h.manager.call(
        { type: "steer", session_id: "00000000-0000-0045", prompt: "x" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING" });
    for (const type of ["resume", "steer"] as const) {
      await expect(
        h.manager.call(
          { type, session_id: "00000000-0000-0065", prompt: "  " },
          h.context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(
        h.manager.call({ type, session_id: " ", prompt: "x" }, h.context),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      for (const session_id of [
        "bad",
        "wf_one",
        "ses_legacy",
        "00000000-0000-0030",
      ]) {
        await expect(
          h.manager.call({ type, session_id, prompt: "x" }, h.context),
        ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      }
    }
    await expect(
      h.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-0030",
          prompt: "x",
          model: "",
        },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    for (const override of [{ model: "" }, { thinking: "high" as const }]) {
      await expect(
        h.manager.call(
          {
            type: "steer",
            session_id: "00000000-0000-0030",
            prompt: "x",
            ...override,
          },
          h.context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("hides parent A records from parent B resume and steer", async () => {
    const h = harness();
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const writesBefore = h.writes.length;
    const otherContext = {
      ...h.context,
      sessionManager: { getSessionId: () => "other-parent" },
    } as unknown as ExtensionContext;

    for (const type of ["resume", "steer"] as const) {
      await expect(
        h.manager.call(
          { type, session_id: "00000000-0000-001f", prompt: "cross-parent" },
          otherContext,
        ),
      ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    }
    expect(h.writes).toHaveLength(writesBefore);
    expect(
      h.calls.filter((entry) => entry.startsWith("find-current:")),
    ).toHaveLength(0);
    expect(h.calls).not.toContain("prompt:cross-parent");
    expect(h.calls).not.toContain("steer:cross-parent");
  });

  it("prevents parent B from steering parent A's running child", async () => {
    let releasePrompt!: (value: ChildExecutionObservation) => void;
    const h = harness({
      promptImpl: () =>
        new Promise((resolve) => {
          releasePrompt = resolve;
        }),
    });
    await callNew(h, {});
    await nextTask();
    const otherContext = {
      ...h.context,
      sessionManager: { getSessionId: () => "other-parent" },
    } as unknown as ExtensionContext;

    await expect(
      h.manager.call(
        {
          type: "steer",
          session_id: "00000000-0000-001f",
          prompt: "cross-parent",
        },
        otherContext,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(h.calls).not.toContain("steer:cross-parent");

    releasePrompt({ output: "done" });
    await nextTask();
  });

  it("steers only a running live child and preserves the running acknowledgement", async () => {
    let releasePrompt!: (value: ChildExecutionObservation) => void;
    let releaseSteer!: () => void;
    const h = harness({
      promptImpl: () =>
        new Promise((resolve) => {
          releasePrompt = resolve;
        }),
      steerImpl: () =>
        new Promise<void>((resolve) => {
          releaseSteer = resolve;
        }),
    });
    await callNew(h, {});
    await nextTask();
    const writeCount = h.writes.length;
    const acknowledgement = h.manager.call(
      {
        type: "steer",
        session_id: "00000000-0000-001f",
        prompt: "  redirect  ",
      },
      h.context,
    );
    expect(h.calls).toContain("steer:redirect");
    expect(h.writes).toHaveLength(writeCount);
    releasePrompt({ output: "settled" });
    await nextTask();
    releaseSteer();
    expect(await acknowledgement).toEqual({
      session_id: "00000000-0000-001f",
      status: "running",
      steered: true,
    });
    await expect(
      h.manager.call(
        { type: "steer", session_id: "00000000-0000-001f", prompt: "late" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING" });
  });

  it("redacts steer failures and rejects terminal records without live children", async () => {
    const failing = harness({
      promptImpl: () => new Promise(() => undefined),
      steerImpl: async () => {
        throw new Error("steer secret");
      },
    });
    await callNew(failing, {});
    await nextTask();
    await expect(
      failing.manager.call(
        { type: "steer", session_id: "00000000-0000-001f", prompt: "x" },
        failing.context,
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: expect.not.stringContaining("secret"),
    });

    const loaded = harness({
      loaded: [
        {
          session_id: "00000000-0000-002c",
          agent: "worker",
          model: "acme/model",
          thinking: "off",
          status: "completed",
          created_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    await loaded.manager.load(loaded.context);
    await expect(
      loaded.manager.call(
        { type: "resume", session_id: "00000000-0000-002c", prompt: "x" },
        loaded.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE" });
    await expect(
      loaded.manager.call(
        { type: "steer", session_id: "00000000-0000-002c", prompt: "x" },
        loaded.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING" });
  });

  it("uses a real RecordStore reload fixture for data-only action failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-runtime-t4-"));
    try {
      const store = new RecordStore({
        agentDir: join(root, "agent"),
        projectPath: "/project",
        parentSessionId: "parent-session",
      });
      await store.writeSession({
        session_id: "00000000-0000-0049",
        agent: "worker",
        model: "acme/model",
        thinking: "off",
        status: "completed",
        created_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:00:01.000Z",
      });
      const h = harness({ store });
      await h.manager.load(h.context);
      await expect(
        h.manager.call(
          { type: "resume", session_id: "00000000-0000-0049", prompt: "x" },
          h.context,
        ),
      ).rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE" });
      await expect(
        h.manager.call(
          { type: "steer", session_id: "00000000-0000-0049", prompt: "x" },
          h.context,
        ),
      ).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("T5 parent shutdown", () => {
  it("retains a prepared child for resume, then disposes it once on namespace close", async () => {
    const h = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    await h.manager.call(
      { type: "resume", session_id: "00000000-0000-001f", prompt: "again" },
      h.context,
    );
    await vi.waitFor(() => expect(h.calls).toContain("prompt:again"));
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(1);

    await h.manager.shutdown(h.context);
    expect(
      h.calls.filter((call) => call === "dispose-preparation"),
    ).toHaveLength(0);
    expect(h.calls.filter((call) => call === "dispose")).toHaveLength(1);
    await expect(
      h.manager.call(
        { type: "resume", session_id: "00000000-0000-001f", prompt: "again" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("disposes a canceled queued preparation and the admitted child exactly once", async () => {
    let releaseHolder!: (value: ChildExecutionObservation) => void;
    const h = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      maxConcurrent: 1,
      promptImpl: async () =>
        new Promise((resolve) => {
          releaseHolder = resolve;
        }),
      abortImpl: async () => releaseHolder({ aborted: true }),
      createIds: ["00000000-0000-0023", "00000000-0000-0062"],
    });
    await callNew(h, { prompt: "holder" });
    await vi.waitFor(() => expect(h.calls).toContain("prompt:holder"));
    await callNew(h, { prompt: "waiting" });

    await h.manager.shutdown(h.context);
    expect(h.calls.filter((call) => call === "create-child")).toHaveLength(1);
    expect(h.calls).not.toContain("prompt:waiting");
    expect(
      h.calls.filter((call) => call === "dispose-preparation"),
    ).toHaveLength(1);
    expect(h.calls.filter((call) => call === "dispose")).toHaveLength(1);
  });

  it("disposes preparation through shutdown when queued and shutdown writes fail", async () => {
    const queuedGate = deferred<void>();
    let writes = 0;
    const h = harness({
      agent: { ...baseAgent, extensions: ["npm:pi-web-access"] },
      store: {
        async writeSession() {
          writes += 1;
          if (writes === 1) await queuedGate.promise;
          throw new Error("persistence secret");
        },
      },
    });
    const call = callNew(h);
    await vi.waitFor(() => expect(writes).toBe(1));
    const shutdown = h.manager.shutdown(h.context);
    queuedGate.resolve();

    await expect(call).resolves.toMatchObject({ status: "aborted" });
    await shutdown;
    expect(
      h.calls.filter((entry) => entry === "dispose-preparation"),
    ).toHaveLength(1);
    expect(h.calls).not.toContain("create-child");
  });

  it("memoizes an awaited namespace barrier, closes admission, and aborts running work", async () => {
    let releasePrompt!: (value: ChildExecutionObservation) => void;
    const h = harness({
      promptImpl: () =>
        new Promise((resolve) => {
          releasePrompt = resolve;
        }),
      abortImpl: async () => {
        releasePrompt({
          output: "observed before shutdown",
          usage: { turns: 1, tool_uses: 0, total_tokens: 7 },
          aborted: true,
        });
      },
    });
    await callNew(h, {});
    await nextTask();

    const first = h.manager.shutdown(h.context);
    const second = h.manager.shutdown(h.context);
    expect(second).toBe(first);
    for (const params of [
      { type: "new", agent: "worker", prompt: "x" },
      { type: "resume", session_id: "00000000-0000-001f", prompt: "x" },
      { type: "steer", session_id: "00000000-0000-001f", prompt: "x" },
    ]) {
      await expect(
        h.manager.call(params as never, h.context),
      ).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "The parent session is shutting down.",
      });
    }
    expect(h.calls.filter((call) => call === "allocate-id")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "find:worker")).toHaveLength(1);

    await first;
    expect(h.calls.indexOf("abort")).toBeLessThan(
      h.calls.indexOf("write:aborted"),
    );
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "aborted",
      output: "observed before shutdown",
      usage: { turns: 1, tool_uses: 0, total_tokens: 7 },
      error: {
        code: "PARENT_SHUTDOWN",
        message:
          "The parent session shut down while the child session was active.",
      },
    });
  });

  it("does not let another parent revive a child after owner shutdown", async () => {
    let releasePrompt!: (value: ChildExecutionObservation) => void;
    const h = harness({
      promptImpl: () =>
        new Promise((resolve) => {
          releasePrompt = resolve;
        }),
      abortImpl: async () => {
        releasePrompt({ aborted: true });
      },
    });
    await callNew(h, {});
    await nextTask();
    await h.manager.shutdown(h.context);
    const writesAfterShutdown = h.writes.length;
    const otherContext = {
      ...h.context,
      sessionManager: { getSessionId: () => "other-parent" },
    } as unknown as ExtensionContext;

    for (const type of ["resume", "steer"] as const) {
      await expect(
        h.manager.call(
          { type, session_id: "00000000-0000-001f", prompt: "cross-parent" },
          otherContext,
        ),
      ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    }
    expect(h.writes).toHaveLength(writesAfterShutdown);
    expect(h.calls.filter((call) => call === "abort")).toHaveLength(1);
    expect(h.calls).not.toContain("prompt:cross-parent");
    expect(h.calls).not.toContain("steer:cross-parent");
    expect(h.manager.getSnapshot("00000000-0000-001f")).toMatchObject({
      status: "aborted",
    });
    expect(h.manager.sessionStatus().active_sessions).toEqual([]);
  });

  it("includes an admitted new session whose queued write is still pending", async () => {
    let releaseQueued!: () => void;
    let queuedStarted!: () => void;
    const queuedGate = new Promise<void>((resolve) => {
      releaseQueued = resolve;
    });
    const started = new Promise<void>((resolve) => {
      queuedStarted = resolve;
    });
    const h = harness({
      writeImpl: async (snapshot, count) => {
        if (snapshot.status === "queued" && count === 1) {
          queuedStarted();
          await queuedGate;
        }
      },
    });
    const call = callNew(h);
    await started;

    const shutdown = h.manager.shutdown(h.context);
    await expect(
      h.manager.output({ session_id: "00000000-0000-001f" }),
    ).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
    releaseQueued();
    await shutdown;
    expect(await call).toMatchObject({ status: "aborted" });
    expect(h.calls).not.toContain("create-child");
    expect(h.writes.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "aborted",
    ]);
  });

  it("aborts a child created after shutdown marking without publishing running or prompting", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const h = harness({ beforeCreateReturn: () => createGate });
    await callNew(h, {});

    const shutdown = h.manager.shutdown(h.context);
    releaseCreate();
    await shutdown;

    expect(h.calls).toContain("abort");
    expect(h.calls).not.toContain("write:running");
    expect(h.calls).not.toContain("prompt:do it");
    expect(h.writes.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "aborted",
    ]);
  });

  it("settles a resume reserved behind its queued write as aborted", async () => {
    let releaseQueued!: () => void;
    let queuedStarted!: () => void;
    const queuedGate = new Promise<void>((resolve) => {
      releaseQueued = resolve;
    });
    const started = new Promise<void>((resolve) => {
      queuedStarted = resolve;
    });
    const h = harness({
      writeImpl: async (snapshot, count) => {
        if (snapshot.status === "queued" && count === 4) {
          queuedStarted();
          await queuedGate;
        }
      },
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const resumed = h.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "again",
        thinking: "high",
      },
      h.context,
    );
    await started;

    const shutdown = h.manager.shutdown(h.context);
    releaseQueued();
    await shutdown;
    expect(await resumed).toMatchObject({ status: "aborted" });
    expect(h.calls.filter((call) => call === "prompt:again")).toHaveLength(0);
    expect(
      h.calls.filter((call) => call.startsWith("configure:")),
    ).toHaveLength(0);
    expect(h.writes.slice(3).map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "aborted",
    ]);
  });

  it("lets a shutdown marker beat an in-flight natural terminal commit", async () => {
    let releaseTerminal!: () => void;
    let terminalStarted!: () => void;
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const started = new Promise<void>((resolve) => {
      terminalStarted = resolve;
    });
    const notify = vi.fn();
    const h = harness({
      notifier: { notify },
      writeImpl: async (snapshot) => {
        if (snapshot.status === "completed") {
          terminalStarted();
          await terminalGate;
        }
      },
    });
    await callNew(h, {});
    await started;

    const shutdown = h.manager.shutdown(h.context);
    releaseTerminal();
    await shutdown;
    expect(h.writes.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "running",
      "completed",
      "aborted",
    ]);
    expect(h.manager.getSnapshot("00000000-0000-001f")).toMatchObject({
      status: "aborted",
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toEqual({
      sessionId: "00000000-0000-001f",
      status: "aborted",
    });
  });

  it("drains an active progress write without allowing it to publish over shutdown", async () => {
    let releaseProgress!: () => void;
    let progressStarted!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    const started = new Promise<void>((resolve) => {
      progressStarted = resolve;
    });
    let releasePrompt!: (value: ChildExecutionObservation) => void;
    const h = harness({
      writeImpl: async (snapshot, count) => {
        if (snapshot.status === "running" && count === 3) {
          progressStarted();
          await progressGate;
        }
      },
      promptImpl: async (_prompt, progress) => {
        progress?.({
          output: "partial",
          usage: { turns: 1, tool_uses: 0, total_tokens: 4 },
        });
        return new Promise((resolve) => {
          releasePrompt = resolve;
        });
      },
      abortImpl: async () => {
        releasePrompt({
          output: "final observed",
          usage: { turns: 1, tool_uses: 0, total_tokens: 5 },
        });
      },
    });
    await callNew(h, {});
    await started;

    const shutdown = h.manager.shutdown(h.context);
    let settled = false;
    shutdown.then(() => {
      settled = true;
    });
    await nextTask();
    expect(settled).toBe(false);
    releaseProgress();
    await shutdown;

    expect(h.writes.map((snapshot) => snapshot.status)).toEqual([
      "queued",
      "running",
      "running",
      "aborted",
    ]);
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({
      status: "aborted",
      output: "final observed",
    });
  });

  it("forces shutdown settlement when abort rejects and the prompt does not independently settle", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectPrompt!: (reason: Error) => void;
      const h = harness({
        promptImpl: () =>
          new Promise((_resolve, reject) => {
            rejectPrompt = reject;
          }),
        abortImpl: async () => {
          throw new Error("abort rejection secret");
        },
      });
      await callNew(h, {});
      await nextTask();

      await h.manager.shutdown(h.context);
      const writesAfterShutdown = h.writes.length;
      rejectPrompt(new Error("late prompt rejection secret"));
      await nextTask();

      expect(h.writes).toHaveLength(writesAfterShutdown);
      expect(h.writes.at(-1)).toMatchObject({
        status: "aborted",
        error: {
          code: "PARENT_SHUTDOWN",
          message:
            "The parent session shut down while the child session was active.",
        },
      });
      expect(h.manager.getSnapshot("00000000-0000-001f")).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
      expect(h.notify).toHaveBeenCalledExactlyOnceWith(
        "[pi-subagents-minimal] A child session could not be aborted cleanly during parent shutdown.",
        "warning",
      );
      expect(JSON.stringify(h.notify.mock.calls)).not.toContain("secret");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("continues other records after redacted abort and persistence failures", async () => {
    const releases = new Map<
      string,
      (value: ChildExecutionObservation) => void
    >();
    let abortCount = 0;
    let abortedWriteCount = 0;
    const h = harness({
      createIds: ["00000000-0000-003c", "00000000-0000-005d"],
      promptImpl: (prompt) =>
        new Promise((resolve) => {
          releases.set(prompt, resolve);
        }),
      abortImpl: async () => {
        abortCount += 1;
        if (abortCount === 1) throw new Error("abort secret");
      },
      writeImpl: async (snapshot) => {
        if (snapshot.status === "aborted" && ++abortedWriteCount === 1) {
          throw new Error("persistence secret");
        }
      },
    });
    await callNew(h, { prompt: "one" });
    await callNew(h, { prompt: "two" });
    await nextTask();

    const shutdown = h.manager.shutdown(h.context);
    releases.get("one")?.({ output: "one" });
    releases.get("two")?.({ output: "two" });
    await shutdown;

    expect(h.manager.getSnapshot("00000000-0000-003c")).toMatchObject({
      status: "aborted",
    });
    expect(h.manager.getSnapshot("00000000-0000-005d")).toMatchObject({
      status: "aborted",
    });
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(
      "[pi-subagents-minimal] A child session could not be aborted cleanly during parent shutdown.",
      "warning",
    );
    expect(h.notify).toHaveBeenCalledWith(
      "[pi-subagents-minimal] An aborted child session could not be persisted during parent shutdown.",
      "warning",
    );
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain("secret");
  });

  it("keeps cleanup failure warn-only after persisting aborted", async () => {
    let releasePrompt!: (value: ChildExecutionObservation) => void;
    const h = harness({
      cleanupError: "cleanup secret token",
      promptImpl: () =>
        new Promise((resolve) => {
          releasePrompt = resolve;
        }),
      abortImpl: async () => {
        releasePrompt({ output: "partial" });
      },
    });
    await callNew(h, {});
    await nextTask();

    await h.manager.shutdown(h.context);
    expect(h.writes.at(-1)).toMatchObject({ status: "aborted" });
    expect(h.manager.getSnapshot("00000000-0000-001f")).toMatchObject({
      status: "aborted",
    });
    expect(h.notify).toHaveBeenCalledWith(
      "[pi-subagents-minimal] Skipped terminal retention cleanup.",
      "warning",
    );
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain(
      "cleanup secret token",
    );
  });

  it("leaves committed terminal records untouched and keeps other namespaces independent", async () => {
    const h = harness({
      createIds: ["00000000-0000-003c", "00000000-0000-005d"],
    });
    await callNew(h);
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-003c" }),
      ).toMatchObject({
        status: "completed",
      });
    });
    const terminal = h.manager.getSnapshot("00000000-0000-003c");
    const writesBeforeShutdown = structuredClone(h.writes);
    await h.manager.shutdown(h.context);
    expect(h.manager.getSnapshot("00000000-0000-003c")).toEqual(terminal);
    expect(h.writes).toEqual(writesBeforeShutdown);
    expect(
      await h.manager.output({ session_id: "00000000-0000-003c" }),
    ).toMatchObject({
      status: "completed",
    });

    const otherContext = {
      ...h.context,
      sessionManager: { getSessionId: () => "other-parent" },
    } as unknown as ExtensionContext;
    expect(
      (await callNew({ ...h, context: otherContext } as typeof h)).session_id,
    ).toBe("00000000-0000-005d");
  });
});
