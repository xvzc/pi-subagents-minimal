/**
 * Boot tests (A1): the extension registers exactly the four public tools,
 * each with a description and parameter schema, and unbound tools fail with
 * a coded envelope instead of throwing into Pi (S1, S4).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, projectConfigPath } from "../src/config.js";
import extension, {
  ACTIVATION_CLEANUP_WARNING,
  createTools,
  runActivationCleanup,
  TOOL_NAMES,
} from "../src/index.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { RecordStore } from "../src/storage/record-store.js";
import { RETENTION_CLEANUP_RESULT_WARNING } from "../src/storage/retention.js";
import type { ToolServices } from "../src/types.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

/** Isolated config paths so activation never reads real host/project config. */
function isolatedConfigOptions(): { agentDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-minimal-boot-"));
  tempRoots.push(root);
  return { agentDir: join(root, "agent"), cwd: join(root, "work") };
}

async function boot(
  services?: Partial<ToolServices>,
): Promise<ToolDefinition<any, any, any>[]> {
  const tools: ToolDefinition<any, any, any>[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  await extension(pi, services, isolatedConfigOptions());
  return tools;
}

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

describe("extension boot", () => {
  it("registers exactly the four named public tools", async () => {
    const names = (await boot()).map((tool) => tool.name);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect([...names].sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_NAMES).toEqual([
      "subagent_call",
      "subagent_output",
      "subagent_list",
      "subagent_status",
    ]);
  });

  it("registers no message renderer and no foreground entry renderer", async () => {
    const registerMessageRenderer = vi.fn();
    const registerEntryRenderer = vi.fn();
    await extension(
      {
        registerTool: () => undefined,
        registerMessageRenderer,
        registerEntryRenderer,
      } as unknown as ExtensionAPI,
      undefined,
      isolatedConfigOptions(),
    );
    expect(registerMessageRenderer).not.toHaveBeenCalled();
    expect(registerEntryRenderer).not.toHaveBeenCalled();
  });

  it("renders subagent_output results as Agent Output", async () => {
    const tools = await boot();
    const output = tools.find((tool) => tool.name === "subagent_output")!;
    expect(typeof output.renderResult).toBe("function");
  });

  it("does not accept an async parameter on subagent_call", async () => {
    const tools = await boot();
    const call = tools.find((tool) => tool.name === "subagent_call")!;
    const properties =
      (call.parameters as { properties?: Record<string, unknown> })
        .properties ?? {};
    expect(properties).not.toHaveProperty("async");
  });

  it("gives every tool a description and an object parameter schema", async () => {
    for (const tool of await boot()) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.label.trim().length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("unbound tools return an error envelope instead of throwing", async () => {
    for (const tool of createTools()) {
      const result = await tool.execute(
        "call-1",
        {},
        undefined,
        undefined,
        {} as never,
      );
      expect(textOf(result)).toBeDefined();
      expect(JSON.parse(textOf(result))).toEqual({
        error: { code: "INTERNAL_ERROR", message: expect.any(String) },
      });
    }
  });

  it("loads the current parent namespace before session_start resolves", async () => {
    const paths = isolatedConfigOptions();
    const store = new RecordStore({
      agentDir: paths.agentDir,
      projectPath: paths.cwd,
      parentSessionId: "parent",
    });
    await store.writeSession({
      session_id: "00000000-0000-002c",
      agent: "worker",
      model: "acme/model",
      thinking: "off",
      status: "completed",
      created_at: "2099-01-01T00:00:00.000Z",
      completed_at: "2099-01-01T00:00:01.000Z",
      output: "loaded",
    });
    const tools: ToolDefinition[] = [];
    let start:
      | ((event: unknown, context: ExtensionContext) => Promise<void>)
      | undefined;
    await extension(
      {
        registerTool: (tool: ToolDefinition) => tools.push(tool),
        on: (name: string, handler: typeof start) => {
          if (name === "session_start") start = handler;
        },
      } as unknown as ExtensionAPI,
      undefined,
      paths,
    );
    expect(start).toBeDefined();
    const notify = vi.fn();
    await start?.({}, {
      cwd: paths.cwd,
      sessionManager: { getSessionId: () => "parent" },
      ui: { notify },
    } as unknown as ExtensionContext);
    // The future-dated stored record is preserved by activation cleanup with
    // one fixed aggregate diagnostic, deferred to this first session_start.
    expect(notify.mock.calls).toEqual([
      [RETENTION_CLEANUP_RESULT_WARNING, "warning"],
    ]);
    const output = tools.find((tool) => tool.name === "subagent_output");
    const result = await output?.execute(
      "call",
      { session_id: "00000000-0000-002c" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(result?.details).toMatchObject({
      status: "completed",
      output: "loaded",
    });
  });

  it("warns once per parent namespace when agent definitions fail to load", async () => {
    const paths = isolatedConfigOptions();
    const agentsDir = join(paths.agentDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "invalid-a.md"),
      "not an agent definition",
      "utf-8",
    );
    writeFileSync(
      join(agentsDir, "invalid-b.md"),
      "---\nname: unsafe-value\ndescription: 42\n---\nsecret body value",
      "utf-8",
    );
    let start:
      | ((event: unknown, context: ExtensionContext) => Promise<void>)
      | undefined;
    await extension(
      {
        registerTool: () => undefined,
        on: (name: string, handler: typeof start) => {
          if (name === "session_start") start = handler;
        },
      } as unknown as ExtensionAPI,
      undefined,
      paths,
    );
    const notify = vi.fn();
    let parentSessionId = "parent-a";
    const context = {
      cwd: paths.cwd,
      sessionManager: { getSessionId: () => parentSessionId },
      ui: { notify },
    } as unknown as ExtensionContext;

    await start?.({}, context);
    await start?.({}, context);
    parentSessionId = "parent-b";
    await start?.({}, context);
    context.cwd = join(paths.cwd, "isolated-worktree");
    await start?.({}, context);

    expect(notify).toHaveBeenCalledTimes(3);
    for (const call of notify.mock.calls) {
      expect(call).toEqual([
        "[pi-subagents-minimal] Agent definition loading warnings: 2. Run subagent_list for details.",
        "warning",
      ]);
    }
    const serializedCalls = JSON.stringify(notify.mock.calls);
    for (const sensitive of [
      "invalid-a.md",
      "invalid-b.md",
      "not an agent definition",
      "unsafe-value",
      "secret body value",
      "missing frontmatter",
    ]) {
      expect(serializedCalls).not.toContain(sensitive);
    }
  });

  it("delivers deferred config diagnostics once per parent namespace at session_start", async () => {
    const paths = isolatedConfigOptions();
    const projectDir = join(paths.cwd, ".pi");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "pi-subagents-minimal.json"),
      JSON.stringify({ notAConfigField: true }),
      "utf-8",
    );
    let start:
      | ((event: unknown, context: ExtensionContext) => Promise<void>)
      | undefined;
    await extension(
      {
        registerTool: () => undefined,
        on: (name: string, handler: typeof start) => {
          if (name === "session_start") start = handler;
        },
      } as unknown as ExtensionAPI,
      undefined,
      paths,
    );
    const notify = vi.fn();
    let parentSessionId = "parent-a";
    const context = {
      cwd: paths.cwd,
      sessionManager: { getSessionId: () => parentSessionId },
      ui: { notify },
    } as unknown as ExtensionContext;

    await start?.({}, context);
    await start?.({}, context);
    parentSessionId = "parent-b";
    await start?.({}, context);

    expect(notify).toHaveBeenCalledTimes(2);
    for (const call of notify.mock.calls) {
      expect(call).toEqual([
        `[pi-subagents-minimal] Ignoring unknown config field "notAConfigField" in ${projectConfigPath(paths.cwd)}.`,
        "warning",
      ]);
    }
  });

  it("delivers no deferred diagnostics when activation is clean and keeps restore running without UI", async () => {
    const paths = isolatedConfigOptions();
    mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
    let start:
      | ((event: unknown, context: ExtensionContext) => Promise<void>)
      | undefined;
    await extension(
      {
        registerTool: () => undefined,
        on: (name: string, handler: typeof start) => {
          if (name === "session_start") start = handler;
        },
      } as unknown as ExtensionAPI,
      undefined,
      paths,
    );
    const context = {
      cwd: paths.cwd,
      sessionManager: { getSessionId: () => "parent" },
    } as unknown as ExtensionContext;

    await expect(start?.({}, context)).resolves.toBeUndefined();
  });

  it("continues session restore when an agent warning notification fails", async () => {
    const paths = isolatedConfigOptions();
    const agentsDir = join(paths.agentDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "invalid.md"),
      "not an agent definition",
      "utf-8",
    );
    const load = vi
      .spyOn(SessionManager.prototype, "load")
      .mockResolvedValue(undefined);
    let start:
      | ((event: unknown, context: ExtensionContext) => Promise<void>)
      | undefined;
    await extension(
      {
        registerTool: () => undefined,
        on: (name: string, handler: typeof start) => {
          if (name === "session_start") start = handler;
        },
      } as unknown as ExtensionAPI,
      undefined,
      paths,
    );
    const context = {
      cwd: paths.cwd,
      sessionManager: { getSessionId: () => "parent" },
      ui: {
        notify: () => {
          throw new Error("ui unavailable");
        },
      },
    } as unknown as ExtensionContext;

    await expect(start?.({}, context)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledWith(context);
    load.mockRestore();
  });

  it("uses fixed activation cleanup diagnostics without exposing returned or thrown secrets", async () => {
    const context = {
      agentDir: "/agent",
      projectPath: "/project",
      config: DEFAULT_CONFIG,
    };
    const secret = "activation-cleanup-secret";

    expect(
      await runActivationCleanup(context, async () => ({
        deletedPaths: [],
        deletedCount: 0,
        warnings: [{ path: `/safe/${secret}`, message: `Skipped ${secret}.` }],
      })),
    ).toEqual([RETENTION_CLEANUP_RESULT_WARNING]);
    expect(
      await runActivationCleanup(context, async () => {
        throw new Error(secret);
      }),
    ).toEqual([ACTIVATION_CLEANUP_WARNING]);
  });

  it("hides terminal rows only for interactive and RPC input without handling input", async () => {
    const onParentInput = vi
      .spyOn(SessionManager.prototype, "onParentInput")
      .mockImplementation(() => undefined);
    let input:
      | ((
          event: { source: "interactive" | "rpc" | "extension"; text: string },
          context: ExtensionContext,
        ) => void)
      | undefined;
    const paths = isolatedConfigOptions();
    await extension(
      {
        registerTool: () => undefined,
        on: (name: string, handler: typeof input) => {
          if (name === "input") input = handler;
        },
      } as unknown as ExtensionAPI,
      undefined,
      paths,
    );
    const context = {
      cwd: paths.cwd,
      sessionManager: { getSessionId: () => "parent" },
    } as unknown as ExtensionContext;
    for (const source of ["interactive", "rpc", "extension"] as const) {
      const event = { source, text: "unchanged" };
      expect(input?.(event, context)).toBeUndefined();
      expect(event).toEqual({ source, text: "unchanged" });
    }
    expect(onParentInput).toHaveBeenCalledTimes(2);
    expect(onParentInput).toHaveBeenNthCalledWith(1, context);
    expect(onParentInput).toHaveBeenNthCalledWith(2, context);
    onParentInput.mockRestore();
  });

  it("registers one awaited shutdown handler for every Pi shutdown reason", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shutdown = vi
      .spyOn(SessionManager.prototype, "shutdown")
      .mockImplementation(() => gate);
    const handlers: Array<
      (event: unknown, context: ExtensionContext) => Promise<void>
    > = [];
    const paths = isolatedConfigOptions();
    await extension(
      {
        registerTool: () => undefined,
        on: (
          name: string,
          handler: (event: unknown, context: ExtensionContext) => Promise<void>,
        ) => {
          if (name === "session_shutdown") handlers.push(handler);
        },
      } as unknown as ExtensionAPI,
      undefined,
      paths,
    );
    expect(handlers).toHaveLength(1);
    const context = {
      cwd: paths.cwd,
      sessionManager: { getSessionId: () => "parent" },
    } as unknown as ExtensionContext;
    const pending = ["quit", "reload", "new", "resume", "fork"].map((reason) =>
      handlers[0]?.({ type: "session_shutdown", reason }, context),
    );
    let settled = false;
    pending[0]?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(shutdown).toHaveBeenCalledTimes(5);
    release();
    await Promise.all(pending);
    expect(settled).toBe(true);
    shutdown.mockRestore();
  });

  it("forwards bound service payloads as serialized tool results", async () => {
    const tools = await boot({
      registry: {
        list: async () => ({ agents: [] }),
      },
    });
    const list = tools.find((tool) => tool.name === "subagent_list");
    expect(list).toBeDefined();
    const result = await list?.execute(
      "call-1",
      {},
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.parse(textOf(result!))).toEqual({ agents: [] });
  });
});
