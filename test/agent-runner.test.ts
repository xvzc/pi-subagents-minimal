import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEventListener,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createOptions: undefined as unknown,
  loaderOptions: undefined as unknown,
  extensionsResult: { extensions: [], errors: [] } as any,
  skills: [] as Array<{ name: string }>,
  session: undefined as unknown,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    DefaultResourceLoader: class {
      constructor(options: unknown) {
        sdk.loaderOptions = options;
      }
      async reload() {}
      getExtensions() {
        return sdk.extensionsResult;
      }
      getSkills() {
        return { skills: sdk.skills, diagnostics: [] };
      }
      getPrompts() {
        return { prompts: [], diagnostics: [] };
      }
      getThemes() {
        return { themes: [], diagnostics: [] };
      }
      getAgentsFiles() {
        return { agentsFiles: [] };
      }
      getSystemPrompt() {
        return undefined;
      }
      getSystemPromptSource() {
        return undefined;
      }
      getAppendSystemPrompt() {
        return [];
      }
      getAppendSystemPromptSources() {
        return [];
      }
      extendResources() {}
    },
    SettingsManager: { inMemory: () => ({ settings: true }) },
    SessionManager: {
      inMemory: (cwd: string, options: unknown) => ({ cwd, options }),
    },
    createAgentSession: async (options: unknown) => {
      sdk.createOptions = options;
      return { session: sdk.session, extensionsResult: {} };
    },
  };
});

import {
  type ChildExecutionObservation,
  createPiChildSessionFactory,
} from "../src/runtime/agent-runner.js";

function fakeModel(): Model<Api> {
  return {
    provider: "acme",
    id: "model",
    reasoning: true,
  } as unknown as Model<Api>;
}

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

function usage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 99,
    cacheWrite: 88,
    totalTokens: input + output + 187,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe("Pi child runner", () => {
  beforeEach(() => {
    sdk.createOptions = undefined;
    sdk.loaderOptions = undefined;
    sdk.extensionsResult = { extensions: [], errors: [] };
    sdk.skills = [];
    sdk.session = undefined;
  });

  it("passes an installed npm entrypoint to Pi with ambient loading disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-runner-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ pi: { extensions: ["./index.ts"] } }),
    );
    const entrypoint = join(packageRoot, "index.ts");
    writeFileSync(entrypoint, "export default () => {};\n");
    const canonicalEntrypoint = realpathSync(entrypoint);
    sdk.extensionsResult = {
      extensions: [
        {
          resolvedPath: canonicalEntrypoint,
          sourceInfo: { source: canonicalEntrypoint },
          tools: new Map([["web_search", {}]]),
        },
      ],
      errors: [],
    };

    const prepared = await createPiChildSessionFactory().prepareExtensions!({
      cwd,
      agentDir,
      systemPrompt: "Child prompt.",
      extensions: ["npm:pi-web-access"],
    });

    expect(sdk.loaderOptions).toMatchObject({
      cwd,
      agentDir,
      noExtensions: true,
      additionalExtensionPaths: [canonicalEntrypoint],
    });
    expect(prepared.knownToolNames).toContain("web_search");
    expect(prepared.knownSkillNames).toEqual([]);

    sdk.session = {};
    const concrete = fakeModel();
    await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
      tools: ["web_search"],
      skills: [],
      extensionPreparation: prepared,
    });
    expect(sdk.createOptions).toMatchObject({ tools: ["web_search"] });
    expect(
      (sdk.createOptions as any).resourceLoader.getSkills().skills,
    ).toEqual([]);
  });

  it("filters the loader skill view used by prompts and skill commands", async () => {
    sdk.skills = [{ name: "allowed" }, { name: "denied" }];
    sdk.session = {};
    const concrete = fakeModel();
    await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
      tools: [],
      skills: ["allowed"],
    });

    const loader = (sdk.createOptions as any).resourceLoader;
    expect(
      loader.getSkills().skills.map((skill: { name: string }) => skill.name),
    ).toEqual(["allowed"]);
  });

  it("reconfigures a retained session through public model and thinking APIs", async () => {
    const order: string[] = [];
    sdk.session = {
      agent: {},
      async setModel(next: Model<Api>) {
        order.push(`model:${next.provider}/${next.id}`);
      },
      setThinkingLevel(level: string) {
        order.push(`thinking:${level}`);
      },
      async steer() {},
      async abort() {},
      dispose() {},
    };
    const initial = fakeModel();
    const replacement = {
      provider: "acme",
      id: "replacement",
      reasoning: true,
    } as unknown as Model<Api>;
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: initial,
      modelRegistry: { find: () => initial } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
    });

    await handle.configure({ model: replacement, thinking: "high" });
    expect(order).toEqual(["model:acme/replacement", "thinking:high"]);

    order.length = 0;
    await handle.configure({ thinking: "low" });
    expect(order).toEqual(["thinking:low"]);
  });

  it("does not apply thinking when retained-session model switching fails", async () => {
    const setThinkingLevel = vi.fn();
    sdk.session = {
      agent: {},
      async setModel() {
        throw new Error("authentication failed");
      },
      setThinkingLevel,
      async steer() {},
      async abort() {},
      dispose() {},
    };
    const initial = fakeModel();
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: initial,
      modelRegistry: { find: () => initial } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
    });

    await expect(
      handle.configure({ model: initial, thinking: "high" }),
    ).rejects.toThrow();
    expect(setThinkingLevel).not.toHaveBeenCalled();
  });

  it("uses public SDK options and stops immediately after the exact turn limit", async () => {
    let listener: AgentSessionEventListener | undefined;
    let turns = 0;
    let unsubscribed = false;
    const agent: { shouldStopAfterTurn?: () => boolean | Promise<boolean> } = {
      shouldStopAfterTurn: undefined,
    };
    sdk.session = {
      agent,
      subscribe(next: AgentSessionEventListener) {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
      async steer() {},
      async abort() {},
      async prompt() {
        while (true) {
          turns += 1;
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "toolUse",
              usage: usage(turns * 1000, turns * 500),
            },
          } as never);
          listener?.({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `turn ${turns}` }],
              stopReason: "toolUse",
            },
            toolResults: [],
          } as never);
          if (await agent.shouldStopAfterTurn?.()) break;
        }
      },
      getSessionStats: () => ({
        assistantMessages: turns,
        toolCalls: 1,
        tokens: { total: 42 },
      }),
      getLastAssistantText: () => `turn ${turns}`,
    };
    const concrete = fakeModel();
    const registry = {
      find: () => concrete,
    } as unknown as ModelRegistry;

    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: registry,
      thinking: "off",
      systemPrompt: "Child prompt.",
      tools: [],
      maxTurns: 2,
    });
    const progress: unknown[] = [];
    const observation = await handle.prompt("go", (snapshot) =>
      progress.push(snapshot),
    );

    expect(turns).toBe(2);
    expect(progress).toEqual([
      {
        output: "turn 1",
        usage: { turns: 1, tool_uses: 1, total_tokens: 42 },
        widgetUsage: { turns: 1, input: 1000, output: 500 },
      },
      {
        output: "turn 2",
        usage: { turns: 2, tool_uses: 1, total_tokens: 42 },
        widgetUsage: { turns: 2, input: 3000, output: 1500 },
      },
    ]);
    expect(observation).toEqual({
      output: "turn 2",
      usage: { turns: 2, tool_uses: 1, total_tokens: 42 },
      widgetUsage: { turns: 2, input: 3000, output: 1500 },
      maxTurnsReached: true,
    });
    expect(unsubscribed).toBe(true);
    expect(sdk.loaderOptions).toMatchObject({
      cwd: "/project",
      agentDir: "/agent-dir",
      noExtensions: true,
      systemPrompt: "Child prompt.",
    });
    expect(sdk.createOptions).toMatchObject({
      cwd: "/project",
      model: concrete,
      thinkingLevel: "off",
      tools: [],
    });
  });

  it("publishes only settled-turn usage and excludes cache fields", async () => {
    let listener: AgentSessionEventListener | undefined;
    let release!: () => void;
    let secondMessageEnded!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      secondMessageEnded = resolve;
    });
    sdk.session = {
      agent: {},
      subscribe(next: AgentSessionEventListener) {
        listener = next;
        return () => undefined;
      },
      async prompt() {
        const assistant = (input: number, output: number) => ({
          role: "assistant",
          content: [],
          stopReason: "toolUse",
          usage: usage(input, output),
        });
        listener?.({
          type: "message_end",
          message: assistant(1200, 300),
        } as never);
        listener?.({
          type: "turn_end",
          message: assistant(1200, 300),
          toolResults: [],
        } as never);
        listener?.({
          type: "message_end",
          message: assistant(800, 700),
        } as never);
        secondMessageEnded();
        await gate;
        listener?.({
          type: "turn_end",
          message: assistant(800, 700),
          toolResults: [],
        } as never);
      },
      async steer() {},
      async abort() {},
      getSessionStats: () => ({
        assistantMessages: 2,
        toolCalls: 0,
        tokens: { total: 999 },
      }),
      getLastAssistantText: () => "done",
    };
    const concrete = fakeModel();
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
    });
    const progress: ChildExecutionObservation[] = [];
    const pending = handle.prompt("go", (snapshot) => progress.push(snapshot));
    await reached;
    expect(progress).toHaveLength(1);
    expect(progress[0]?.widgetUsage).toEqual({
      turns: 1,
      input: 1200,
      output: 300,
    });
    release();
    await pending;
    expect(progress[1]?.widgetUsage).toEqual({
      turns: 2,
      input: 2000,
      output: 1000,
    });
    expect(progress[1]?.widgetUsage).not.toHaveProperty("cacheRead");
    expect(progress[1]?.widgetUsage).not.toHaveProperty("cacheWrite");
  });

  it("retains only fixed assistant-stop diagnostics from observable SDK fields", async () => {
    let listener: AgentSessionEventListener | undefined;
    sdk.session = {
      agent: {},
      subscribe(next: AgentSessionEventListener) {
        listener = next;
        return () => undefined;
      },
      async prompt() {
        listener?.({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            rawStopReason: "provider secret raw reason",
            errorMessage: "Provider secret error message",
          },
          toolResults: [],
        } as never);
      },
      async steer() {},
      async abort() {},
      getSessionStats: () => ({
        assistantMessages: 1,
        toolCalls: 0,
        tokens: { total: 0 },
      }),
      getLastAssistantText: () => "",
    };
    const concrete = fakeModel();
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
    });

    const observation = await handle.prompt("go");
    expect(observation).toMatchObject({
      error: {
        code: "CHILD_EXECUTION_FAILED",
        message: "The child assistant turn failed.",
      },
    });
    expect(observation.error?.diagnostic).toEqual({
      phase: "assistant_stop",
      assistant_turn: 1,
      stop_reason: "error",
    });
  });

  it("ignores provider text and malformed Unicode prompt/output during classification", async () => {
    let listener: AgentSessionEventListener | undefined;
    const prompt = "\ud800 malformed prompt";
    sdk.session = {
      agent: {},
      subscribe(next: AgentSessionEventListener) {
        listener = next;
        return () => undefined;
      },
      async prompt() {
        listener?.({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            rawStopReason: "\udfff provider-controlled raw reason",
            errorMessage: "\udfff provider-controlled error message",
          },
          toolResults: [],
        } as never);
      },
      async steer() {},
      async abort() {},
      getSessionStats: () => ({
        assistantMessages: 1,
        toolCalls: 0,
        tokens: { total: 0 },
      }),
      getLastAssistantText: () => "\udfff malformed assistant output",
    };
    const concrete = fakeModel();
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
    });

    expect((await handle.prompt(prompt)).error?.diagnostic).toEqual({
      phase: "assistant_stop",
      assistant_turn: 1,
      stop_reason: "error",
    });
  });

  it("distinguishes prompt throws while omitting all untrusted thrown messages", async () => {
    const prompt = "private customer prompt";
    const unsafeMessages = [
      prompt.toUpperCase(),
      encodeURIComponent(prompt),
      "Cookie: session=safe; auth=must-not-persist",
      "AWS credential AKIAIOSFODNN7EXAMPLE",
      "OPENAI_API_KEY=must-not-persist",
      "Provider failed at secretFrame (/private/file.ts:1:2)",
    ];
    const concrete = fakeModel();

    for (const unsafeMessage of unsafeMessages) {
      sdk.session = {
        agent: {},
        subscribe() {
          return () => undefined;
        },
        async prompt() {
          throw unsafeMessage === unsafeMessages[0]
            ? unsafeMessage
            : new Error(unsafeMessage);
        },
        async steer() {},
        async abort() {},
        getSessionStats: () => ({
          assistantMessages: 0,
          toolCalls: 0,
          tokens: { total: 0 },
        }),
        getLastAssistantText: () => undefined,
      };
      const handle = await createPiChildSessionFactory().create({
        id: "00000000-0000-001f",
        cwd: "/project",
        agentDir: "/agent-dir",
        parentSessionId: "parent",
        model: concrete,
        modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
        thinking: "off",
        systemPrompt: "Child prompt.",
      });

      const observation = await handle.prompt(prompt);
      expect(observation, unsafeMessage).toMatchObject({
        error: {
          code: "CHILD_EXECUTION_FAILED",
          message: "The child assistant turn failed.",
          diagnostic: { phase: "prompt_throw" },
        },
      });
      expect(observation.error?.diagnostic).toEqual({ phase: "prompt_throw" });
    }
  });

  it("installs fresh per-prompt state and delegates trimmed steer", async () => {
    let listener: AgentSessionEventListener | undefined;
    let totalTurns = 0;
    let promptNumber = 0;
    const steers: string[] = [];
    let aborted = false;
    let disposed = false;
    const agent: { shouldStopAfterTurn?: () => boolean | Promise<boolean> } = {
      shouldStopAfterTurn: undefined,
    };
    sdk.session = {
      agent,
      subscribe(next: AgentSessionEventListener) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        promptNumber += 1;
        if (promptNumber === 3) return;
        while (true) {
          totalTurns += 1;
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "toolUse",
              usage: usage(10, 5),
            },
          } as never);
          listener?.({
            type: "turn_end",
            message: { role: "assistant", content: [], stopReason: "toolUse" },
            toolResults: [],
          } as never);
          if (await agent.shouldStopAfterTurn?.()) break;
        }
      },
      async steer(prompt: string) {
        steers.push(prompt);
      },
      async abort() {
        aborted = true;
      },
      dispose() {
        disposed = true;
      },
      getSessionStats: () => ({
        assistantMessages: totalTurns,
        toolCalls: 0,
        tokens: { total: totalTurns * 5 },
      }),
      getLastAssistantText: () => `turn ${totalTurns}`,
    };
    const concrete = fakeModel();
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
      maxTurns: 2,
    });

    expect((await handle.prompt("one")).maxTurnsReached).toBe(true);
    const second = await handle.prompt("two");
    expect(second).toMatchObject({
      output: "turn 4",
      widgetUsage: { turns: 2, input: 20, output: 10 },
      maxTurnsReached: true,
    });
    const third = await handle.prompt("no assistant");
    expect(third.output).toBeUndefined();
    expect(third.maxTurnsReached).toBeUndefined();
    await handle.steer("  change course  ");
    await handle.abort();
    handle.dispose?.();
    expect(steers).toEqual(["change course"]);
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
  });

  it("enforces the limit through the current finishTurn hook and composes the host hook", async () => {
    let listener: AgentSessionEventListener | undefined;
    let turns = 0;
    let hostCalls = 0;
    let unsubscribed = false;
    const agent: {
      finishTurn?: (turn: {
        message: { stopReason?: string };
      }) => Promise<{ action: "continue" | "end" } | undefined>;
    } = {
      finishTurn: async () => {
        hostCalls += 1;
        return { action: "continue" };
      },
    };
    sdk.session = {
      agent,
      subscribe(next: AgentSessionEventListener) {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      },
      async steer() {},
      async abort() {},
      async prompt() {
        while (true) {
          turns += 1;
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "toolUse",
              usage: usage(turns * 1000, turns * 500),
            },
          } as never);
          const decision = await agent.finishTurn?.({
            message: { stopReason: "toolUse" },
          });
          listener?.({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `turn ${turns}` }],
              stopReason: "toolUse",
            },
            toolResults: [],
          } as never);
          if (decision?.action === "end") break;
        }
      },
      getSessionStats: () => ({
        assistantMessages: turns,
        toolCalls: 1,
        tokens: { total: 42 },
      }),
      getLastAssistantText: () => `turn ${turns}`,
    };
    const concrete = fakeModel();
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
      tools: [],
      maxTurns: 2,
    });
    const progress: ChildExecutionObservation[] = [];
    const observation = await handle.prompt("go", (snapshot) =>
      progress.push(snapshot),
    );

    expect(turns).toBe(2);
    expect(hostCalls).toBe(2);
    expect(progress).toHaveLength(2);
    expect(observation).toEqual({
      output: "turn 2",
      usage: { turns: 2, tool_uses: 1, total_tokens: 42 },
      widgetUsage: { turns: 2, input: 3000, output: 1500 },
      maxTurnsReached: true,
    });
    expect(unsubscribed).toBe(true);

    const resumed = await handle.prompt("again");
    expect(turns).toBe(4);
    expect(hostCalls).toBe(4);
    expect(resumed).toMatchObject({
      output: "turn 4",
      maxTurnsReached: true,
    });
  });

  it("does not classify errored or aborted turns as turn limits under finishTurn", async () => {
    for (const stopReason of ["error", "aborted"] as const) {
      let listener: AgentSessionEventListener | undefined;
      const agent: {
        finishTurn?: (turn: {
          message: { stopReason?: string };
        }) => Promise<{ action: "continue" | "end" } | undefined>;
      } = { finishTurn: async () => undefined };
      sdk.session = {
        agent,
        subscribe(next: AgentSessionEventListener) {
          listener = next;
          return () => undefined;
        },
        async steer() {},
        async abort() {},
        async prompt() {
          const message = {
            role: "assistant",
            content: [],
            stopReason,
            usage: usage(10, 5),
          };
          listener?.({ type: "message_end", message } as never);
          await agent.finishTurn?.({ message: { stopReason } });
          listener?.({ type: "turn_end", message, toolResults: [] } as never);
        },
        getSessionStats: () => ({
          assistantMessages: 1,
          toolCalls: 0,
          tokens: { total: 15 },
        }),
        getLastAssistantText: () => undefined,
      };
      const concrete = fakeModel();
      const handle = await createPiChildSessionFactory().create({
        id: "00000000-0000-001f",
        cwd: "/project",
        agentDir: "/agent-dir",
        parentSessionId: "parent",
        model: concrete,
        modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
        thinking: "off",
        systemPrompt: "Child prompt.",
        maxTurns: 1,
      });

      const observation = await handle.prompt("go");
      expect(observation.maxTurnsReached, stopReason).toBeUndefined();
      if (stopReason === "aborted") {
        expect(observation.aborted).toBe(true);
      } else {
        expect(observation.error?.diagnostic).toEqual({
          phase: "assistant_stop",
          assistant_turn: 1,
          stop_reason: "error",
        });
      }
    }
  });

  it("fails closed when a requested turn limit has no runtime hook to enforce it", async () => {
    let prompted = false;
    sdk.session = {
      agent: {},
      subscribe() {
        return () => undefined;
      },
      async steer() {},
      async abort() {},
      async prompt() {
        prompted = true;
      },
      getSessionStats: () => ({
        assistantMessages: 0,
        toolCalls: 0,
        tokens: { total: 0 },
      }),
      getLastAssistantText: () => undefined,
    };
    const concrete = fakeModel();
    const handle = await createPiChildSessionFactory().create({
      id: "00000000-0000-001f",
      cwd: "/project",
      agentDir: "/agent-dir",
      parentSessionId: "parent",
      model: concrete,
      modelRegistry: { find: () => concrete } as unknown as ModelRegistry,
      thinking: "off",
      systemPrompt: "Child prompt.",
      maxTurns: 3,
    });

    const observation = await handle.prompt("go");
    expect(prompted).toBe(false);
    expect(observation.maxTurnsReached).toBeUndefined();
    expect(observation.error).toMatchObject({
      code: "CHILD_TURN_LIMIT_UNSUPPORTED",
    });
  });
});
