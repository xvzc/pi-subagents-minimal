import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createTools } from "../src/index.js";
import type {
  ChildExecutionObservation,
  ChildSessionFactory,
} from "../src/runtime/agent-runner.js";
import type { AsyncCompletionNotifier } from "../src/runtime/completion-notify.js";
import {
  SessionManager,
  type SessionRecordStore,
} from "../src/runtime/session-manager.js";
import type { PersistedSessionSnapshot } from "../src/storage/schemas.js";
import type { AgentDefinition, ThinkingLevel } from "../src/types.js";

function model(): Model<Api> {
  return {
    provider: "acme",
    id: "model",
    reasoning: true,
  } as unknown as Model<Api>;
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
    maxConcurrent?: number;
    createIds?: string[];
    notifier?: AsyncCompletionNotifier;
    promptImpl?: (
      prompt: string,
      progress?: (observation: ChildExecutionObservation) => void,
    ) => Promise<ChildExecutionObservation>;
    abortImpl?: (id: string) => Promise<void> | void;
    beforePrepareReturn?: () => Promise<void>;
    beforeCreateReturn?: (id: string) => Promise<void>;
    writeImpl?: (
      snapshot: PersistedSessionSnapshot,
      count: number,
    ) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const writes: PersistedSessionSnapshot[] = [];
  const pending = new Map<string, (value: ChildExecutionObservation) => void>();
  let writeCount = 0;
  const childFactory: ChildSessionFactory = {
    knownToolNames: ["read", "bash"],
    async prepareExtensions() {
      calls.push("prepare-extensions");
      await options.beforePrepareReturn?.();
      return {
        resourceLoader: {} as never,
        settingsManager: {} as never,
        knownToolNames: ["read", "bash"],
        knownSkillNames: [],
        dispose() {
          calls.push("dispose-preparation");
        },
      };
    },
    async create(input) {
      calls.push(`create-child:${input.id}`);
      await options.beforeCreateReturn?.(input.id);
      const gate = new Promise<ChildExecutionObservation>((resolve) => {
        pending.set(input.id, resolve);
      });
      return {
        async prompt(prompt, progress) {
          calls.push(`prompt:${prompt}`);
          if (options.promptImpl) return options.promptImpl(prompt, progress);
          return gate;
        },
        async configure() {},
        async steer() {},
        async abort() {
          calls.push(`abort:${input.id}`);
          await options.abortImpl?.(input.id);
          pending.get(input.id)?.({ aborted: true });
          pending.delete(input.id);
        },
        dispose() {
          calls.push(`dispose:${input.id}`);
        },
      };
    },
  };
  const manager = new SessionManager({
    config: {
      historyRetentionDays: 7,
      maxConcurrentSubagents: options.maxConcurrent ?? 8,
      injectGuidelines: true,
    },
    agentDir: "/agent-dir",
    ...(options.notifier ? { notifier: options.notifier } : {}),
    registry: {
      snapshot: () => ({ definitions: [], warnings: [] }),
      listCandidates: () => ({ definitions: [], warnings: [] }),
      findForSession: (name: string) =>
        name === baseAgent.name ? baseAgent : undefined,
      findCurrent: (name: string) =>
        name === baseAgent.name ? baseAgent : undefined,
    },
    childFactory,
    createStore: (): SessionRecordStore => ({
      async writeSession(snapshot) {
        calls.push(`write:${snapshot.status}:${snapshot.session_id}`);
        writeCount += 1;
        await options.writeImpl?.(snapshot, writeCount);
        writes.push(structuredClone(snapshot));
      },
      async loadSessions() {
        return { records: [], warnings: [] };
      },
    }),
    cleanup: async () => ({}),
    now: (() => {
      let tick = 0;
      return () => `2026-01-01T00:00:0${tick++}.000Z`;
    })(),
    createId: () => {
      calls.push("allocate-id");
      return (
        options.createIds?.shift() ??
        `00000000-0000-${calls.length.toString(16).padStart(4, "0")}`
      );
    },
  });
  const catalog = [model()];
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
    model: model(),
    thinkingLevel: "medium" as ThinkingLevel,
  } as unknown as ExtensionContext;
  return { manager, context, calls, writes };
}

function otherNamespace(h: ReturnType<typeof harness>): ExtensionContext {
  return {
    ...h.context,
    cwd: "/other-project",
    sessionManager: { getSessionId: () => "other-parent" },
  } as unknown as ExtensionContext;
}

function thirdNamespace(h: ReturnType<typeof harness>): ExtensionContext {
  return {
    ...h.context,
    cwd: "/third-project",
    sessionManager: { getSessionId: () => "third-parent" },
  } as unknown as ExtensionContext;
}

function abortedWritesFor(
  h: ReturnType<typeof harness>,
  sessionId: string,
): PersistedSessionSnapshot[] {
  return h.writes.filter(
    (snapshot) =>
      snapshot.session_id === sessionId && snapshot.status === "aborted",
  );
}

function pushesFor(
  notify: ReturnType<typeof vi.fn>,
  sessionId: string,
): unknown[] {
  return notify.mock.calls
    .map(([signal]) => signal)
    .filter((signal) => signal.sessionId === sessionId);
}

function callTool(h: ReturnType<typeof harness>) {
  return createTools({ sessions: h.manager }).find(
    (tool) => tool.name === "subagent_call",
  )!;
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

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("004 parent operation abort cascade", () => {
  it("aborts every running record in the namespace with one push each", async () => {
    const notify = vi.fn();
    const h = harness({
      createIds: ["00000000-0000-0006", "00000000-0000-000e"],
      notifier: { notify },
    });
    const tool = callTool(h);
    const controller = new AbortController();
    await tool.execute(
      "id-1",
      { type: "new", agent: "worker", prompt: "one" },
      controller.signal,
      undefined,
      h.context,
    );
    await tool.execute(
      "id-2",
      { type: "new", agent: "worker", prompt: "two" },
      controller.signal,
      undefined,
      h.context,
    );
    await nextTask();
    expect(
      h.calls.filter((call) => call.startsWith("create-child")),
    ).toHaveLength(2);

    controller.abort();
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0006" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
      expect(
        await h.manager.output({ session_id: "00000000-0000-000e" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
    });
    expect(
      h.calls.filter((call) => call === "abort:00000000-0000-0006"),
    ).toHaveLength(1);
    expect(
      h.calls.filter((call) => call === "abort:00000000-0000-000e"),
    ).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-0006",
      status: "aborted",
    });
    expect(notify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-000e",
      status: "aborted",
    });
  });

  it("aborts queued records without creating their child", async () => {
    const notify = vi.fn();
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-004e", "00000000-0000-0061"],
      notifier: { notify },
    });
    const tool = callTool(h);
    const controller = new AbortController();
    await tool.execute(
      "id-1",
      { type: "new", agent: "worker", prompt: "first" },
      controller.signal,
      undefined,
      h.context,
    );
    await tool.execute(
      "id-2",
      { type: "new", agent: "worker", prompt: "second" },
      controller.signal,
      undefined,
      h.context,
    );
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-0061" }),
    ).toMatchObject({
      status: "queued",
    });
    expect(
      h.calls.filter((call) => call.startsWith("create-child")),
    ).toHaveLength(1);

    controller.abort();
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0061" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
      expect(
        await h.manager.output({ session_id: "00000000-0000-004e" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
    });
    expect(
      h.calls.filter((call) => call.startsWith("create-child")),
    ).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("leaves other namespaces running and admits later independent calls", async () => {
    const notify = vi.fn();
    const h = harness({
      createIds: [
        "00000000-0000-002f",
        "00000000-0000-005c",
        "00000000-0000-0033",
      ],
      notifier: { notify },
    });
    const other = otherNamespace(h);
    const tool = callTool(h);
    const mine = new AbortController();
    await tool.execute(
      "id-1",
      { type: "new", agent: "worker", prompt: "mine" },
      mine.signal,
      undefined,
      h.context,
    );
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "theirs" },
      other,
    );
    await nextTask();

    mine.abort();
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-002f" }),
      ).toMatchObject({
        status: "aborted",
      });
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-005c" }),
    ).toMatchObject({
      status: "running",
    });
    expect(h.calls).not.toContain("abort:00000000-0000-005c");

    const fresh = new AbortController();
    const accepted = await tool.execute(
      "id-2",
      { type: "new", agent: "worker", prompt: "next" },
      fresh.signal,
      undefined,
      h.context,
    );
    expect(accepted.details).toMatchObject({
      session_id: "00000000-0000-0033",
      status: "queued",
    });
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-0033" }),
    ).toMatchObject({
      status: "running",
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-005c" }),
    ).toMatchObject({
      status: "running",
    });
  });

  it("already-aborted signals abort existing records and prevent new mutation", async () => {
    const notify = vi.fn();
    const h = harness({
      createIds: ["00000000-0000-003b"],
      notifier: { notify },
    });
    const tool = callTool(h);
    const first = new AbortController();
    await tool.execute(
      "id-1",
      { type: "new", agent: "worker", prompt: "old" },
      first.signal,
      undefined,
      h.context,
    );
    await nextTask();
    const allocatesBefore = h.calls.filter(
      (call) => call === "allocate-id",
    ).length;

    const aborted = new AbortController();
    aborted.abort();
    const result = await tool.execute(
      "id-2",
      { type: "new", agent: "worker", prompt: "rejected" },
      aborted.signal,
      undefined,
      h.context,
    );
    expect(result.details).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "The parent operation was aborted.",
      },
    });
    expect(h.calls.filter((call) => call === "allocate-id")).toHaveLength(
      allocatesBefore,
    );
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-003b" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-003b",
      status: "aborted",
    });
  });

  it("binds a shared signal once and stays effective after execute returns", async () => {
    const notify = vi.fn();
    const h = harness({
      createIds: ["00000000-0000-0006", "00000000-0000-000e"],
      notifier: { notify },
    });
    const tool = callTool(h);
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    await tool.execute(
      "id-1",
      { type: "new", agent: "worker", prompt: "one" },
      controller.signal,
      undefined,
      h.context,
    );
    await tool.execute(
      "id-2",
      { type: "new", agent: "worker", prompt: "two" },
      controller.signal,
      undefined,
      h.context,
    );
    expect(addSpy).toHaveBeenCalledTimes(1);
    addSpy.mockRestore();
    await nextTask();

    controller.abort();
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
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("keeps a natural completion exactly once when abort races settlement", async () => {
    const notify = vi.fn();
    let release!: (value: ChildExecutionObservation) => void;
    const h = harness({
      createIds: ["00000000-0000-0017"],
      notifier: { notify },
      promptImpl: () =>
        new Promise<ChildExecutionObservation>((resolve) => {
          release = resolve;
        }),
    });
    const tool = callTool(h);
    const controller = new AbortController();
    await tool.execute(
      "id-1",
      { type: "new", agent: "worker", prompt: "work" },
      controller.signal,
      undefined,
      h.context,
    );
    await nextTask();
    release({ output: "finished" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0017" }),
      ).toMatchObject({
        status: "completed",
        output: "finished",
      });
    });
    controller.abort();
    await nextTask();
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-0017" }),
    ).toMatchObject({
      status: "completed",
      output: "finished",
    });
    expect(h.calls).not.toContain("abort:00000000-0000-0017");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-0017",
      status: "completed",
    });
  });

  it("observes abort after blocked extension preparation without creating a record", async () => {
    const prepareGate = deferred<void>();
    const h = harness({
      createIds: ["00000000-0000-0031"],
      beforePrepareReturn: () => prepareGate.promise,
    });
    const controller = new AbortController();
    const call = callTool(h).execute(
      "id-prepare",
      { type: "new", agent: "worker", prompt: "work" },
      controller.signal,
      undefined,
      h.context,
    );
    await vi.waitFor(() => expect(h.calls).toContain("prepare-extensions"));

    controller.abort();
    prepareGate.resolve();
    const result = await call;
    expect(result.details).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "The parent operation was aborted.",
      },
    });
    expect(h.calls).toContain("allocate-id");
    expect(h.calls.some((entry) => entry.startsWith("write:"))).toBe(false);
    expect(h.calls.some((entry) => entry.startsWith("create-child:"))).toBe(
      false,
    );
    expect(
      h.calls.filter((entry) => entry === "dispose-preparation"),
    ).toHaveLength(1);
  });

  it.each(["resolve", "reject"] as const)(
    "lets abort win a blocked natural terminal write when it %s",
    async (continuation) => {
      const terminalGate = deferred<void>();
      const notify = vi.fn();
      const h = harness({
        createIds: ["00000000-0000-005b"],
        notifier: { notify },
        promptImpl: async () => ({ output: "natural" }),
        writeImpl: (snapshot) =>
          snapshot.status === "completed"
            ? terminalGate.promise
            : Promise.resolve(),
      });
      const controller = new AbortController();
      await callTool(h).execute(
        "id-terminal",
        { type: "new", agent: "worker", prompt: "work" },
        controller.signal,
        undefined,
        h.context,
      );
      await vi.waitFor(() =>
        expect(h.calls).toContain("write:completed:00000000-0000-005b"),
      );

      controller.abort();
      await nextTask();
      expect(notify).not.toHaveBeenCalled();
      if (continuation === "resolve") terminalGate.resolve();
      else terminalGate.reject(new Error("terminal write failed"));

      await vi.waitFor(async () => {
        expect(
          await h.manager.output({ session_id: "00000000-0000-005b" }),
        ).toMatchObject({
          status: "aborted",
          error: { code: "PARENT_SHUTDOWN" },
        });
      });
      expect(h.writes.at(-1)).toMatchObject({
        session_id: "00000000-0000-005b",
        status: "aborted",
      });
      expect(abortedWritesFor(h, "00000000-0000-005b")).toHaveLength(1);
      expect(abortedWritesFor(h, "00000000-0000-005b")[0]).toMatchObject({
        error: { code: "PARENT_SHUTDOWN" },
      });
      if (continuation === "resolve") {
        expect(
          h.writes.filter(
            (snapshot) =>
              snapshot.session_id === "00000000-0000-005b" &&
              snapshot.status === "completed",
          ),
        ).toHaveLength(1);
      } else {
        expect(
          h.writes.some(
            (snapshot) =>
              snapshot.session_id === "00000000-0000-005b" &&
              snapshot.status === "completed",
          ),
        ).toBe(false);
      }
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith({
        sessionId: "00000000-0000-005b",
        status: "aborted",
      });
      expect(pushesFor(notify, "00000000-0000-005b")).toHaveLength(1);
    },
  );

  it("drains every queued progress write before persisting abort", async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    const promptGate = deferred<ChildExecutionObservation>();
    let secondStarted = false;
    const progressNotify = vi.fn();
    const h = harness({
      createIds: ["00000000-0000-0042"],
      notifier: { notify: progressNotify },
      promptImpl: async (_prompt, progress) => {
        progress?.({ output: "progress one" });
        progress?.({ output: "progress two" });
        return promptGate.promise;
      },
      abortImpl: () => promptGate.resolve({ aborted: true }),
      writeImpl: (snapshot) => {
        if (snapshot.output === "progress one") return firstWrite.promise;
        if (snapshot.output === "progress two") {
          secondStarted = true;
          return secondWrite.promise;
        }
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    await callTool(h).execute(
      "id-progress",
      { type: "new", agent: "worker", prompt: "work" },
      controller.signal,
      undefined,
      h.context,
    );
    await vi.waitFor(() =>
      expect(
        h.calls.filter((entry) => entry === "write:running:00000000-0000-0042"),
      ).toHaveLength(2),
    );

    controller.abort();
    await nextTask();
    expect(secondStarted).toBe(false);
    expect(h.writes.some((snapshot) => snapshot.status === "aborted")).toBe(
      false,
    );
    firstWrite.resolve();
    await vi.waitFor(() => expect(secondStarted).toBe(true));
    expect(h.writes.some((snapshot) => snapshot.status === "aborted")).toBe(
      false,
    );
    secondWrite.resolve();

    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0042" }),
      ).toMatchObject({ status: "aborted" });
    });
    expect(h.writes.at(-1)).toMatchObject({
      session_id: "00000000-0000-0042",
      status: "aborted",
    });
    expect(abortedWritesFor(h, "00000000-0000-0042")).toHaveLength(1);
    expect(progressNotify).toHaveBeenCalledTimes(1);
    expect(progressNotify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-0042",
      status: "aborted",
    });
  });

  it("holds the slot through blocked creation, then aborts the created child once", async () => {
    const createGate = deferred<void>();
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-0013", "00000000-0000-0062"],
      beforeCreateReturn: (id) =>
        id === "00000000-0000-0013" ? createGate.promise : Promise.resolve(),
    });
    const tool = callTool(h);
    const other = otherNamespace(h);
    const controller = new AbortController();
    await tool.execute(
      "id-create",
      { type: "new", agent: "worker", prompt: "creating" },
      controller.signal,
      undefined,
      h.context,
    );
    await vi.waitFor(() =>
      expect(h.calls).toContain("create-child:00000000-0000-0013"),
    );
    await tool.execute(
      "id-waiting",
      { type: "new", agent: "worker", prompt: "waiting" },
      new AbortController().signal,
      undefined,
      other,
    );

    controller.abort();
    await nextTask();
    expect(h.calls).not.toContain("create-child:00000000-0000-0062");
    expect(h.calls).not.toContain("abort:00000000-0000-0013");
    expect(
      await h.manager.output({ session_id: "00000000-0000-0013" }),
    ).toMatchObject({
      status: "queued",
    });
    createGate.resolve();

    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0013" }),
      ).toMatchObject({ status: "aborted" });
      expect(h.calls).toContain("create-child:00000000-0000-0062");
    });
    expect(
      h.calls.filter((entry) => entry === "abort:00000000-0000-0013"),
    ).toHaveLength(1);
  });

  it("coordinates operation abort and shutdown while child creation is blocked", async () => {
    const createGate = deferred<void>();
    const notify = vi.fn();
    const h = harness({
      createIds: ["00000000-0000-0013"],
      notifier: { notify },
      beforeCreateReturn: () => createGate.promise,
    });
    const controller = new AbortController();
    await callTool(h).execute(
      "id-create-shutdown",
      { type: "new", agent: "worker", prompt: "creating" },
      controller.signal,
      undefined,
      h.context,
    );
    await vi.waitFor(() =>
      expect(h.calls).toContain("create-child:00000000-0000-0013"),
    );

    controller.abort();
    const shutdown = h.manager.shutdown(h.context);
    await nextTask();
    expect(h.calls).not.toContain("abort:00000000-0000-0013");
    createGate.resolve();
    await shutdown;

    expect(
      await h.manager.output({ session_id: "00000000-0000-0013" }),
    ).toMatchObject({
      status: "aborted",
      error: { code: "PARENT_SHUTDOWN" },
    });
    expect(
      h.calls.filter((entry) => entry === "abort:00000000-0000-0013"),
    ).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(abortedWritesFor(h, "00000000-0000-0013")).toHaveLength(1);
    expect(pushesFor(notify, "00000000-0000-0013")).toHaveLength(1);
  });

  it("does not roll back a resume when its queued write rejects after abort", async () => {
    const resumeWrite = deferred<void>();
    const notify = vi.fn();
    let blockResume = false;
    const h = harness({
      createIds: ["00000000-0000-004d"],
      notifier: { notify },
      promptImpl: async () => ({ output: "initial" }),
      writeImpl: (snapshot) =>
        blockResume && snapshot.status === "queued"
          ? resumeWrite.promise
          : Promise.resolve(),
    });
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "initial" },
      h.context,
    );
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-004d" }),
      ).toMatchObject({
        status: "completed",
      });
    });
    notify.mockClear();
    blockResume = true;
    const controller = new AbortController();
    const resume = callTool(h).execute(
      "id-resume",
      { type: "resume", session_id: "00000000-0000-004d", prompt: "again" },
      controller.signal,
      undefined,
      h.context,
    );
    await vi.waitFor(() =>
      expect(
        h.calls.filter((entry) => entry === "write:queued:00000000-0000-004d"),
      ).toHaveLength(2),
    );

    controller.abort();
    resumeWrite.reject(new Error("queued write failed"));
    await resume;
    expect(
      await h.manager.output({ session_id: "00000000-0000-004d" }),
    ).toMatchObject({
      status: "aborted",
      error: { code: "PARENT_SHUTDOWN" },
    });
    expect(h.writes.at(-1)).toMatchObject({
      session_id: "00000000-0000-004d",
      status: "aborted",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-004d",
      status: "aborted",
    });
  });

  it("completes abort and shutdown concurrently without duplicate settlement", async () => {
    const notify = vi.fn();
    const h = harness({
      createIds: ["00000000-0000-003c"],
      notifier: { notify },
    });
    const tool = callTool(h);
    const controller = new AbortController();
    await tool.execute(
      "id-1",
      { type: "new", agent: "worker", prompt: "work" },
      controller.signal,
      undefined,
      h.context,
    );
    await nextTask();
    controller.abort();
    await h.manager.shutdown(h.context);
    expect(
      await h.manager.output({ session_id: "00000000-0000-003c" }),
    ).toMatchObject({
      status: "aborted",
      error: { code: "PARENT_SHUTDOWN" },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "00000000-0000-003c",
      status: "aborted",
    });
    expect(abortedWritesFor(h, "00000000-0000-003c")).toHaveLength(1);
    expect(pushesFor(notify, "00000000-0000-003c")).toHaveLength(1);
  });

  it("associates one shared signal with two namespaces while isolating a third", async () => {
    const notify = vi.fn();
    const h = harness({
      createIds: [
        "00000000-0000-0036",
        "00000000-0000-0037",
        "00000000-0000-0039",
        "00000000-0000-0038",
      ],
      notifier: { notify },
    });
    const other = otherNamespace(h);
    const third = thirdNamespace(h);
    const tool = callTool(h);
    const shared = new AbortController();
    await tool.execute(
      "id-ns1",
      { type: "new", agent: "worker", prompt: "ns1 work" },
      shared.signal,
      undefined,
      h.context,
    );
    await tool.execute(
      "id-ns2",
      { type: "new", agent: "worker", prompt: "ns2 work" },
      shared.signal,
      undefined,
      other,
    );
    await tool.execute(
      "id-ns3",
      { type: "new", agent: "worker", prompt: "ns3 work" },
      new AbortController().signal,
      undefined,
      third,
    );
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-0036" }),
    ).toMatchObject({
      status: "running",
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-0037" }),
    ).toMatchObject({
      status: "running",
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-0039" }),
    ).toMatchObject({
      status: "running",
    });

    shared.abort();
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-0036" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
      expect(
        await h.manager.output({ session_id: "00000000-0000-0037" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
    });
    expect(
      await h.manager.output({ session_id: "00000000-0000-0039" }),
    ).toMatchObject({
      status: "running",
    });
    expect(h.calls).not.toContain("abort:00000000-0000-0039");
    expect(abortedWritesFor(h, "00000000-0000-0036")).toHaveLength(1);
    expect(abortedWritesFor(h, "00000000-0000-0037")).toHaveLength(1);
    expect(abortedWritesFor(h, "00000000-0000-0039")).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(pushesFor(notify, "00000000-0000-0036")).toEqual([
      { sessionId: "00000000-0000-0036", status: "aborted" },
    ]);
    expect(pushesFor(notify, "00000000-0000-0037")).toEqual([
      { sessionId: "00000000-0000-0037", status: "aborted" },
    ]);
    expect(pushesFor(notify, "00000000-0000-0039")).toHaveLength(0);

    const next = new AbortController();
    const accepted = await tool.execute(
      "id-ns2-next",
      { type: "new", agent: "worker", prompt: "ns2 again" },
      next.signal,
      undefined,
      other,
    );
    expect(accepted.details).toMatchObject({
      session_id: "00000000-0000-0038",
      status: "queued",
    });
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-0038" }),
    ).toMatchObject({
      status: "running",
    });
  });

  it("writes exactly one aborted snapshot and push per queued and running session", async () => {
    const notify = vi.fn();
    const h = harness({
      maxConcurrent: 1,
      createIds: ["00000000-0000-004f", "00000000-0000-0044"],
      notifier: { notify },
    });
    const tool = callTool(h);
    const controller = new AbortController();
    await tool.execute(
      "id-run-once",
      { type: "new", agent: "worker", prompt: "running" },
      controller.signal,
      undefined,
      h.context,
    );
    await tool.execute(
      "id-queue-once",
      { type: "new", agent: "worker", prompt: "queued" },
      controller.signal,
      undefined,
      h.context,
    );
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-0044" }),
    ).toMatchObject({
      status: "queued",
    });

    controller.abort();
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-004f" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
      expect(
        await h.manager.output({ session_id: "00000000-0000-0044" }),
      ).toMatchObject({
        status: "aborted",
        error: { code: "PARENT_SHUTDOWN" },
      });
    });
    expect(
      h.calls.filter((call) => call.startsWith("create-child")),
    ).toHaveLength(1);
    expect(abortedWritesFor(h, "00000000-0000-004f")).toHaveLength(1);
    expect(abortedWritesFor(h, "00000000-0000-0044")).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(pushesFor(notify, "00000000-0000-004f")).toEqual([
      { sessionId: "00000000-0000-004f", status: "aborted" },
    ]);
    expect(pushesFor(notify, "00000000-0000-0044")).toEqual([
      { sessionId: "00000000-0000-0044", status: "aborted" },
    ]);
  });

  it("repeating abort notification settles each session only once", async () => {
    const notify = vi.fn();
    const h = harness({
      createIds: ["00000000-0000-004c"],
      notifier: { notify },
    });
    const tool = callTool(h);
    const controller = new AbortController();
    await tool.execute(
      "id-repeat",
      { type: "new", agent: "worker", prompt: "work" },
      controller.signal,
      undefined,
      h.context,
    );
    await nextTask();

    controller.abort();
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-004c" }),
      ).toMatchObject({
        status: "aborted",
      });
    });
    expect(abortedWritesFor(h, "00000000-0000-004c")).toHaveLength(1);
    expect(pushesFor(notify, "00000000-0000-004c")).toHaveLength(1);

    const repeated = await tool.execute(
      "id-repeat-again",
      { type: "new", agent: "worker", prompt: "work" },
      controller.signal,
      undefined,
      h.context,
    );
    expect(repeated.details).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "The parent operation was aborted.",
      },
    });
    await nextTask();
    await nextTask();
    expect(
      await h.manager.output({ session_id: "00000000-0000-004c" }),
    ).toMatchObject({
      status: "aborted",
      error: { code: "PARENT_SHUTDOWN" },
    });
    expect(abortedWritesFor(h, "00000000-0000-004c")).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(pushesFor(notify, "00000000-0000-004c")).toHaveLength(1);
    expect(
      h.calls.filter((call) => call === "abort:00000000-0000-004c"),
    ).toHaveLength(1);
  });
});
