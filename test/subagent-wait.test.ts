import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import extension, { createTools } from "../src/index.js";
import type {
  ChildExecutionObservation,
  ChildSessionFactory,
} from "../src/runtime/agent-runner.js";
import {
  SessionManager,
  type SessionRecordStore,
} from "../src/runtime/session-manager.js";
import { SubagentWaitSchema } from "../src/schemas.js";
import { sessionRecordPath } from "../src/storage/paths.js";
import type { PersistedSessionSnapshot } from "../src/storage/schemas.js";
import type { AgentDefinition, ThinkingLevel } from "../src/types.js";

const agent: AgentDefinition = {
  name: "worker",
  description: "Worker.",
  tools: [],
  disallowedTools: [],
  skills: [],
  disallowedSkills: [],
  enabled: true,
  systemPrompt: "Work.",
  source: "project",
  sourcePath: "/agents/worker.md",
};

function model(): Model<Api> {
  return { provider: "acme", id: "model", reasoning: true } as Model<Api>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(
  options: {
    ids?: string[];
    maxConcurrent?: number;
    notifier?: (signal: unknown) => void;
    write?: (snapshot: PersistedSessionSnapshot) => Promise<void>;
    loaded?: PersistedSessionSnapshot[];
    cleanup?: (context: ExtensionContext) => Promise<unknown>;
  } = {},
) {
  const ids = [...(options.ids ?? [])];
  const prompts = new Map<
    string,
    ReturnType<typeof deferred<ChildExecutionObservation>>
  >();
  const aborts: string[] = [];
  const writes: PersistedSessionSnapshot[] = [];
  const childFactory: ChildSessionFactory = {
    knownToolNames: [],
    async prepareExtensions() {
      return {
        resourceLoader: {} as never,
        settingsManager: {} as never,
        knownToolNames: [],
        knownSkillNames: [],
        dispose() {},
      };
    },
    async create(input) {
      return {
        prompt: async () => {
          const prompt = deferred<ChildExecutionObservation>();
          prompts.set(input.id, prompt);
          return prompt.promise;
        },
        configure: async () => undefined,
        steer: async () => undefined,
        abort: async () => {
          aborts.push(input.id);
          prompts.get(input.id)?.resolve({ aborted: true });
        },
      };
    },
  };
  const store: SessionRecordStore = {
    async writeSession(snapshot) {
      await options.write?.(snapshot);
      writes.push(structuredClone(snapshot));
    },
    async loadSessions() {
      return { records: options.loaded ?? [], warnings: [] };
    },
  };
  const manager = new SessionManager({
    config: {
      historyRetentionDays: 7,
      maxConcurrentSubagents: options.maxConcurrent ?? 8,
      injectGuidelines: true,
    },
    agentDir: "/agent",
    registry: {
      snapshot: () => ({ definitions: [], warnings: [] }),
      listCandidates: () => ({ definitions: [], warnings: [] }),
      findForSession: (name: string) =>
        name === agent.name ? agent : undefined,
      findCurrent: (name: string) => (name === agent.name ? agent : undefined),
    },
    childFactory,
    createStore: () => store,
    cleanup: options.cleanup ?? (async () => ({})),
    createId: () => ids.shift() ?? "00000000-0000-000c",
    now: (() => {
      let tick = 0;
      return () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;
    })(),
    ...(options.notifier ? { notifier: { notify: options.notifier } } : {}),
  });
  const catalog = [model()];
  const modelRegistry = {
    getAll: () => catalog,
    find: (provider: string, id: string) =>
      catalog.find((entry) => entry.provider === provider && entry.id === id),
  } as ModelRegistry;
  const context = {
    cwd: "/project",
    sessionManager: { getSessionId: () => "parent" },
    modelRegistry,
    model: model(),
    thinkingLevel: "medium" as ThinkingLevel,
  } as ExtensionContext;
  const otherContext = {
    ...context,
    cwd: "/other",
    sessionManager: { getSessionId: () => "other-parent" },
  } as ExtensionContext;

  return {
    manager,
    context,
    otherContext,
    prompts,
    aborts,
    writes,
    async start(prompt: string, target = context) {
      return manager.call({ type: "new", agent: "worker", prompt }, target);
    },
    complete(id: string, observation: ChildExecutionObservation = {}) {
      const prompt = prompts.get(id);
      expect(prompt, `${id} has started`).toBeDefined();
      prompts.delete(id);
      prompt?.resolve(observation);
    },
    waitTool() {
      return createTools({ sessions: manager }).find(
        (tool) => tool.name === "subagent_wait",
      )!;
    },
  };
}

async function expectRunning(
  manager: SessionManager,
  sessionId: string,
): Promise<void> {
  await vi.waitFor(async () => {
    expect(await manager.output({ session_id: sessionId })).toMatchObject({
      status: "running",
    });
  });
}

describe("subagent_wait", () => {
  it("exposes only a non-empty unique session_ids parameter", () => {
    expect(Value.Check(SubagentWaitSchema, { session_ids: ["plain"] })).toBe(
      true,
    );
    expect(Value.Check(SubagentWaitSchema, { session_ids: [] })).toBe(false);
    expect(
      Value.Check(SubagentWaitSchema, {
        session_ids: ["00000000-0000-0006", "00000000-0000-0006"],
      }),
    ).toBe(false);
    expect(
      Value.Check(SubagentWaitSchema, {
        session_ids: ["00000000-0000-0006"],
        timeout: 1,
      }),
    ).toBe(false);
  });

  it("waits for every queued/running session and returns ordered projections only", async () => {
    const h = harness({
      ids: ["00000000-0000-0006", "00000000-0000-000e"],
      maxConcurrent: 1,
    });
    await h.start("a");
    await h.start("b");
    await expectRunning(h.manager, "00000000-0000-0006");
    expect(
      await h.manager.output({ session_id: "00000000-0000-000e" }),
    ).toMatchObject({
      status: "queued",
    });

    const wait = h.manager.wait(
      { session_ids: ["00000000-0000-000e", "00000000-0000-0006"] },
      h.context,
    );
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    h.complete("00000000-0000-0006", { output: "full output" });
    await vi.waitFor(() =>
      expect(h.prompts.has("00000000-0000-000e")).toBe(true),
    );
    expect(settled).toBe(false);
    h.complete("00000000-0000-000e", { usage: { total_tokens: 3 } });

    await expect(wait).resolves.toEqual({
      reason: "completed",
      terminal: [
        { session_id: "00000000-0000-000e", status: "completed" },
        { session_id: "00000000-0000-0006", status: "completed" },
      ],
      pending: [],
    });
  });

  it.each([
    {
      terminal: "failed" as const,
      observation: {
        error: { code: "CHILD_FAILED", message: "failed" },
      },
    },
    {
      terminal: "stopped" as const,
      observation: { maxTurnsReached: true },
    },
  ])(
    "joins natural $terminal settlement",
    async ({ terminal, observation }) => {
      const sessionId =
        terminal === "failed" ? "00000000-0000-0101" : "00000000-0000-0102";
      const h = harness({ ids: [sessionId] });
      await h.start(terminal);
      await expectRunning(h.manager, sessionId);
      const wait = h.manager.wait({ session_ids: [sessionId] }, h.context);
      h.complete(sessionId, observation);
      await expect(wait).resolves.toEqual({
        reason: "completed",
        terminal: [{ session_id: sessionId, status: terminal }],
        pending: [],
      });
    },
  );

  it("joins queued and running abort publication in requested order", async () => {
    const h = harness({
      ids: ["00000000-0000-0050", "00000000-0000-0045"],
      maxConcurrent: 1,
    });
    await h.start("running");
    await h.start("queued");
    await expectRunning(h.manager, "00000000-0000-0050");
    expect(
      await h.manager.output({ session_id: "00000000-0000-0045" }),
    ).toMatchObject({
      status: "queued",
    });
    const wait = h.manager.wait(
      { session_ids: ["00000000-0000-0045", "00000000-0000-0050"] },
      h.context,
    );
    const controller = new AbortController();
    h.manager.bindOperationSignal(controller.signal, h.context);
    controller.abort();

    await expect(wait).resolves.toEqual({
      reason: "completed",
      terminal: [
        { session_id: "00000000-0000-0045", status: "aborted" },
        { session_id: "00000000-0000-0050", status: "aborted" },
      ],
      pending: [],
    });
    expect(h.aborts).toEqual(["00000000-0000-0050"]);
  });

  it("returns immediately for authoritative terminal snapshots without residual state", async () => {
    const h = harness({
      loaded: [
        {
          session_id: "00000000-0000-0017",
          agent: "worker",
          model: "acme/model",
          thinking: "off",
          status: "failed",
          created_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:00:01.000Z",
          error: { code: "FAILED", message: "secret detail" },
        },
      ],
    });
    await h.manager.load(h.context);
    const first = await h.manager.wait(
      { session_ids: ["00000000-0000-0017"] },
      h.context,
    );
    const second = await h.manager.wait(
      { session_ids: ["00000000-0000-0017"] },
      h.context,
    );
    expect(first).toEqual({
      reason: "completed",
      terminal: [{ session_id: "00000000-0000-0017", status: "failed" }],
      pending: [],
    });
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("secret detail");
  });

  it("interrupts on parent input without aborting children and freshly re-waits", async () => {
    const h = harness({ ids: ["00000000-0000-0006", "00000000-0000-000e"] });
    await h.start("a");
    await h.start("b");
    await expectRunning(h.manager, "00000000-0000-0006");
    await expectRunning(h.manager, "00000000-0000-000e");

    const interrupted = h.manager.wait(
      { session_ids: ["00000000-0000-000e", "00000000-0000-0006"] },
      h.context,
    );
    expect(h.manager.onParentInput(h.context)).toBeUndefined();
    await expect(interrupted).resolves.toEqual({
      reason: "interrupted",
      terminal: [],
      pending: [
        { session_id: "00000000-0000-000e", status: "running" },
        { session_id: "00000000-0000-0006", status: "running" },
      ],
    });
    expect(h.aborts).toEqual([]);

    h.complete("00000000-0000-0006");
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0006" }),
      ).toMatchObject({
        status: "completed",
      });
    });
    const rewait = h.manager.wait(
      { session_ids: ["00000000-0000-000e", "00000000-0000-0006"] },
      h.context,
    );
    h.complete("00000000-0000-000e");
    await expect(rewait).resolves.toEqual({
      reason: "completed",
      terminal: [
        { session_id: "00000000-0000-000e", status: "completed" },
        { session_id: "00000000-0000-0006", status: "completed" },
      ],
      pending: [],
    });
  });

  it("keeps extension input inert and passes interactive input through while interrupting a real waiter", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-wait-input-"));
    const h = harness({ ids: ["00000000-0000-0026"] });
    const tools: ToolDefinition[] = [];
    let input:
      | ((
          event: { source: "interactive" | "rpc" | "extension"; text: string },
          context: ExtensionContext,
        ) => unknown)
      | undefined;
    try {
      await extension(
        {
          registerTool: (tool: ToolDefinition) => tools.push(tool),
          on: (name: string, handler: typeof input) => {
            if (name === "input") input = handler;
          },
        } as unknown as ExtensionAPI,
        { sessions: h.manager },
        { agentDir: join(root, "agent"), cwd: join(root, "project") },
      );
      await h.start("input");
      await expectRunning(h.manager, "00000000-0000-0026");
      const waitTool = tools.find((tool) => tool.name === "subagent_wait")!;
      const wait = waitTool.execute(
        "wait-input-hook",
        { session_ids: ["00000000-0000-0026"] },
        undefined,
        undefined,
        h.context,
      );
      let settled = false;
      void wait.then(() => {
        settled = true;
      });

      const extensionEvent = { source: "extension" as const, text: "keep me" };
      expect(input?.(extensionEvent, h.context)).toBeUndefined();
      expect(extensionEvent).toEqual({ source: "extension", text: "keep me" });
      await Promise.resolve();
      expect(settled).toBe(false);

      const interactiveEvent = {
        source: "interactive" as const,
        text: "keep me too",
      };
      expect(input?.(interactiveEvent, h.context)).toBeUndefined();
      expect(interactiveEvent).toEqual({
        source: "interactive",
        text: "keep me too",
      });
      await expect(wait).resolves.toMatchObject({
        details: {
          reason: "interrupted",
          pending: [{ session_id: "00000000-0000-0026", status: "running" }],
        },
      });
      h.complete("00000000-0000-0026");
      await vi.waitFor(async () => {
        expect(
          await h.manager.output({ session_id: "00000000-0000-0026" }),
        ).toMatchObject({ status: "completed" });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a blocked resume queued write as an active lifecycle", async () => {
    const queuedWrite = deferred<void>();
    let blockResume = false;
    let resumeWriteStarted = false;
    const h = harness({
      ids: ["00000000-0000-004d"],
      write: (snapshot) => {
        if (!blockResume || snapshot.status !== "queued") {
          return Promise.resolve();
        }
        resumeWriteStarted = true;
        return queuedWrite.promise;
      },
    });
    await h.start("initial");
    await expectRunning(h.manager, "00000000-0000-004d");
    h.complete("00000000-0000-004d", { output: "initial result" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-004d" }),
      ).toMatchObject({ status: "completed" });
    });

    blockResume = true;
    const resume = h.manager.call(
      { type: "resume", session_id: "00000000-0000-004d", prompt: "continue" },
      h.context,
    );
    await vi.waitFor(() => expect(resumeWriteStarted).toBe(true));
    const wait = h.manager.wait(
      { session_ids: ["00000000-0000-004d"] },
      h.context,
    );
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    queuedWrite.resolve();
    await resume;
    await vi.waitFor(() =>
      expect(h.prompts.has("00000000-0000-004d")).toBe(true),
    );
    h.complete("00000000-0000-004d", { output: "resumed result" });
    await expect(wait).resolves.toEqual({
      reason: "completed",
      terminal: [{ session_id: "00000000-0000-004d", status: "completed" }],
      pending: [],
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-004d" }),
    ).toMatchObject({
      output: "resumed result",
    });
  });

  it("keeps validated records stable across retention eviction", async () => {
    const evictedPath = sessionRecordPath({
      agentDir: "/agent",
      projectPath: "/project",
      parentSessionId: "parent",
      sessionId: "00000000-0000-003b",
    });
    let cleanupCount = 0;
    const h = harness({
      ids: ["00000000-0000-003b", "00000000-0000-004a"],
      cleanup: async () => {
        cleanupCount += 1;
        return {
          deletedPaths: cleanupCount === 1 ? [evictedPath] : [],
          deletedCount: cleanupCount === 1 ? 1 : 0,
          warnings: [],
        };
      },
    });
    await h.start("old");
    await h.start("remaining");
    await expectRunning(h.manager, "00000000-0000-003b");
    await expectRunning(h.manager, "00000000-0000-004a");
    const wait = h.manager.wait(
      { session_ids: ["00000000-0000-004a", "00000000-0000-003b"] },
      h.context,
    );

    h.complete("00000000-0000-003b");
    await vi.waitFor(() =>
      expect(h.manager.getSnapshot("00000000-0000-003b")).toBeUndefined(),
    );
    h.complete("00000000-0000-004a");
    await expect(wait).resolves.toEqual({
      reason: "completed",
      terminal: [
        { session_id: "00000000-0000-004a", status: "completed" },
        { session_id: "00000000-0000-003b", status: "completed" },
      ],
      pending: [],
    });
  });

  it("does not lose a terminal publication blocked during wait startup", async () => {
    const terminalWrite = deferred<void>();
    let terminalWriteStarted = false;
    const h = harness({
      ids: ["00000000-0000-0047"],
      write: (snapshot) => {
        if (snapshot.status !== "completed") return Promise.resolve();
        terminalWriteStarted = true;
        return terminalWrite.promise;
      },
    });
    await h.start("race");
    await expectRunning(h.manager, "00000000-0000-0047");
    h.complete("00000000-0000-0047");
    await vi.waitFor(() => expect(terminalWriteStarted).toBe(true));
    const wait = h.manager.wait(
      { session_ids: ["00000000-0000-0047"] },
      h.context,
    );
    terminalWrite.resolve();
    await expect(wait).resolves.toEqual({
      reason: "completed",
      terminal: [{ session_id: "00000000-0000-0047", status: "completed" }],
      pending: [],
    });
  });

  it("rejects malformed, missing, and foreign IDs atomically and enforces namespace waiters", async () => {
    const h = harness({ ids: ["00000000-0000-002f", "00000000-0000-003e"] });
    await h.start("mine");
    await h.start("other", h.otherContext);
    await expectRunning(h.manager, "00000000-0000-002f");
    await expectRunning(h.manager, "00000000-0000-003e");

    for (const sessionIds of [
      ["bad"],
      ["ses_legacy"],
      ["00000000-0000-0030"],
      ["00000000-0000-002f", "00000000-0000-003e"],
    ]) {
      await expect(
        h.manager.wait({ session_ids: sessionIds }, h.context),
      ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    }

    const mine = h.manager.wait(
      { session_ids: ["00000000-0000-002f"] },
      h.context,
    );
    await expect(
      h.manager.wait({ session_ids: ["00000000-0000-002f"] }, h.context),
    ).rejects.toMatchObject({ code: "SESSION_BUSY" });
    const other = h.manager.wait(
      { session_ids: ["00000000-0000-003e"] },
      h.otherContext,
    );
    h.complete("00000000-0000-002f");
    h.complete("00000000-0000-003e");
    await expect(mine).resolves.toMatchObject({ reason: "completed" });
    await expect(other).resolves.toMatchObject({ reason: "completed" });
  });

  it("keeps completion as the single winner against later input, abort, and shutdown", async () => {
    const h = harness({ ids: ["00000000-0000-0064"] });
    await h.start("winner");
    await expectRunning(h.manager, "00000000-0000-0064");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const wait = h
      .waitTool()
      .execute(
        "wait-winner",
        { session_ids: ["00000000-0000-0064"] },
        controller.signal,
        undefined,
        h.context,
      );
    h.complete("00000000-0000-0064");
    await expect(wait).resolves.toMatchObject({
      details: {
        reason: "completed",
        terminal: [{ session_id: "00000000-0000-0064", status: "completed" }],
        pending: [],
      },
    });
    expect(remove).toHaveBeenCalledTimes(1);

    h.manager.onParentInput(h.context);
    controller.abort();
    await h.manager.shutdown(h.context);
    expect(h.aborts).toEqual([]);
    expect(
      await h.manager.output({ session_id: "00000000-0000-0064" }),
    ).toMatchObject({
      status: "completed",
    });
    remove.mockRestore();
  });

  it("operation abort rejects and cleans the wait while cancelling the namespace once", async () => {
    const notify = vi.fn();
    const h = harness({
      ids: ["00000000-0000-0006", "00000000-0000-000e"],
      notifier: notify,
    });
    await h.start("a");
    await h.start("b");
    await expectRunning(h.manager, "00000000-0000-0006");
    await expectRunning(h.manager, "00000000-0000-000e");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const wait = h
      .waitTool()
      .execute(
        "wait",
        { session_ids: ["00000000-0000-0006", "00000000-0000-000e"] },
        controller.signal,
        undefined,
        h.context,
      );
    controller.abort();

    await expect(wait).resolves.toMatchObject({
      details: {
        error: {
          code: "INTERNAL_ERROR",
          message: "The parent operation was aborted.",
        },
      },
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0006" }),
      ).toMatchObject({
        status: "aborted",
      });
      expect(
        await h.manager.output({ session_id: "00000000-0000-000e" }),
      ).toMatchObject({
        status: "aborted",
      });
    });
    expect(h.aborts.sort()).toEqual([
      "00000000-0000-0006",
      "00000000-0000-000e",
    ]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    h.manager.onParentInput(h.context);
    await expect(
      h.manager.wait({ session_ids: ["00000000-0000-0006"] }, h.context),
    ).resolves.toMatchObject({ reason: "completed" });
    remove.mockRestore();
  });

  it("an already-aborted operation mutates no waiter and still cancels namespace children", async () => {
    const h = harness({ ids: ["00000000-0000-001b"] });
    await h.start("existing");
    await expectRunning(h.manager, "00000000-0000-001b");
    const controller = new AbortController();
    controller.abort();

    const result = await h
      .waitTool()
      .execute(
        "wait-aborted",
        { session_ids: ["00000000-0000-001b"] },
        controller.signal,
        undefined,
        h.context,
      );
    expect(result.details).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The parent operation was aborted.",
      },
    });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001b" }),
      ).toMatchObject({ status: "aborted" });
    });
    expect(h.aborts).toEqual(["00000000-0000-001b"]);
    await expect(
      h.manager.wait({ session_ids: ["00000000-0000-001b"] }, h.context),
    ).resolves.toMatchObject({ reason: "completed" });
  });

  it("shutdown rejects and cleans an active waiter exactly once", async () => {
    const h = harness({ ids: ["00000000-0000-0054"] });
    await h.start("shutdown");
    await expectRunning(h.manager, "00000000-0000-0054");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const wait = h.manager.wait(
      { session_ids: ["00000000-0000-0054"] },
      h.context,
      controller.signal,
    );
    const rejected = expect(wait).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The parent session is shutting down.",
    });
    await h.manager.shutdown(h.context);
    await rejected;
    controller.abort();
    expect(h.aborts).toEqual(["00000000-0000-0054"]);
    expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

  it("cleans the production tool listener after input wins and preserves completion pushes", async () => {
    const notify = vi.fn();
    const h = harness({ ids: ["00000000-0000-0017"], notifier: notify });
    await h.start("done");
    await expectRunning(h.manager, "00000000-0000-0017");
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const wait = h
      .waitTool()
      .execute(
        "wait-input",
        { session_ids: ["00000000-0000-0017"] },
        controller.signal,
        undefined,
        h.context,
      );
    h.manager.onParentInput(h.context);
    await expect(wait).resolves.toMatchObject({
      details: { reason: "interrupted" },
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));

    h.complete("00000000-0000-0017", { output: "retained" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-0017",
      status: "completed",
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-0017" }),
    ).toMatchObject({
      output: "retained",
    });
    await expect(
      h.manager.wait({ session_ids: ["00000000-0000-0017"] }, h.context),
    ).resolves.toMatchObject({ reason: "completed" });
    controller.abort();
    await h.manager.shutdown(h.context);
    expect(h.aborts).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
