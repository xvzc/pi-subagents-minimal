/**
 * Isolated workspace (`workspaceDir`) coverage for `subagent_call`.
 *
 * A supplied directory changes only child execution: the created child
 * receives it as its cwd, while extension preparation, session storage, and
 * the parent namespace stay rooted at the parent `context.cwd`. `resume` and
 * `steer` reject any supplied value before session lookup.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentCallSchema } from "../src/schemas.js";
import type {
  ChildExtensionPrepareInput,
  ChildSessionCreateInput,
} from "../src/runtime/agent-runner.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import type { PersistedSessionSnapshot } from "../src/storage/schemas.js";
import type { AgentDefinition } from "../src/types.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function fakeModel(): Model<Api> {
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
  parentCwd: string,
  options: {
    createIds?: string[];
    promptImpl?: (prompt: string) => Promise<{ output: string }>;
  } = {},
) {
  const calls: string[] = [];
  const writes: PersistedSessionSnapshot[] = [];
  const prepareInputs: ChildExtensionPrepareInput[] = [];
  const createInputs: ChildSessionCreateInput[] = [];
  const storeCwds: string[] = [];
  const cleanupCwds: string[] = [];
  const childFactory = {
    knownToolNames: ["read"],
    async prepareExtensions(input: ChildExtensionPrepareInput) {
      calls.push("prepare-extensions");
      prepareInputs.push(input);
      return {
        resourceLoader: {} as never,
        settingsManager: {} as never,
        knownToolNames: ["read"],
        knownSkillNames: [],
        dispose() {
          calls.push("dispose-preparation");
        },
      };
    },
    async create(input: ChildSessionCreateInput) {
      calls.push("create-child");
      createInputs.push(input);
      return {
        async prompt(prompt: string) {
          calls.push(`prompt:${prompt}`);
          if (options.promptImpl) return options.promptImpl(prompt);
          return { output: "done" };
        },
        async configure() {
          calls.push("configure");
        },
        async steer(prompt: string) {
          calls.push(`steer:${prompt}`);
        },
        async abort() {
          calls.push("abort");
        },
      };
    },
  };
  const model = fakeModel();
  const registry = {
    getAll: () => [model],
    find: (provider: string, id: string) =>
      provider === "acme" && id === "model" ? model : undefined,
  } as unknown as ModelRegistry;
  const manager = new SessionManager({
    config: {
      historyRetentionDays: 7,
      maxConcurrentSubagents: 8,
      injectGuidelines: true,
    },
    agentDir: tempDir("pi-workspace-agent-"),
    registry: {
      snapshot: () => ({ definitions: [], warnings: [] }),
      listCandidates: () => ({ definitions: [], warnings: [] }),
      findForSession: (name: string) => {
        calls.push(`find:${name}`);
        return name === baseAgent.name ? baseAgent : undefined;
      },
      findCurrent: (name: string) => {
        calls.push(`find-current:${name}`);
        return name === baseAgent.name ? baseAgent : undefined;
      },
    },
    childFactory,
    createStore: (context: ExtensionContext) => {
      storeCwds.push(context.cwd);
      return {
        async writeSession(snapshot: PersistedSessionSnapshot) {
          calls.push(`write:${snapshot.status}`);
          writes.push(structuredClone(snapshot));
        },
      };
    },
    cleanup: (context: ExtensionContext) => {
      cleanupCwds.push(context.cwd);
      calls.push("cleanup");
      return Promise.resolve({});
    },
    now: () => "2026-01-01T00:00:00.000Z",
    createId: () => {
      calls.push("allocate-id");
      return options.createIds?.shift() ?? "00000000-0000-001f";
    },
  });
  const context = {
    cwd: parentCwd,
    sessionManager: { getSessionId: () => "parent-session" },
    modelRegistry: registry,
    model,
    thinkingLevel: "medium",
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  return {
    manager,
    context,
    calls,
    writes,
    prepareInputs,
    createInputs,
    storeCwds,
    cleanupCwds,
  };
}

function workspaceDescription(): string {
  const schema = SubagentCallSchema as unknown as {
    properties: Record<string, { description?: string }>;
  };
  const description = schema.properties.workspaceDir?.description;
  expect(description).toBeTypeOf("string");
  return description as string;
}

describe("workspaceDir schema contract", () => {
  it("is optional, accepts a string, and rejects null", () => {
    expect(
      Value.Check(SubagentCallSchema, {
        type: "new",
        agent: "worker",
        prompt: "do work",
      }),
    ).toBe(true);
    expect(
      Value.Check(SubagentCallSchema, {
        type: "new",
        agent: "worker",
        prompt: "do work",
        workspaceDir: "/tmp/isolated-work",
      }),
    ).toBe(true);
    expect(
      Value.Check(SubagentCallSchema, {
        type: "new",
        agent: "worker",
        prompt: "do work",
        workspaceDir: null,
      }),
    ).toBe(false);
    expect(
      Value.Check(SubagentCallSchema, {
        type: "new",
        agent: "worker",
        prompt: "do work",
        workspaceDir: 42,
      }),
    ).toBe(false);
  });

  it("describes isolated-workspace-only semantics rooted at the parent cwd", () => {
    const description = workspaceDescription();
    expect(description).toContain("isolated workspace");
    expect(description).toContain("parent cwd");
    expect(description).toContain("remain");
    expect(description).toContain('Only valid for type: "new"');
  });
});

describe("workspaceDir execution", () => {
  it("falls back to the parent cwd when omitted", async () => {
    const parent = tempDir("pi-workspace-parent-");
    const h = harness(parent);
    const accepted = await h.manager.call(
      { type: "new", agent: "worker", prompt: "do work" },
      h.context,
    );
    expect(accepted).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    expect(h.prepareInputs).toHaveLength(1);
    expect(h.prepareInputs[0]?.cwd).toBe(parent);
    expect(h.createInputs).toHaveLength(1);
    expect(h.createInputs[0]?.cwd).toBe(parent);
  });

  it("sends only child creation to the workspace and keeps parent roots", async () => {
    const parent = tempDir("pi-workspace-parent-");
    const workspace = tempDir("pi-workspace-child-");
    const h = harness(parent);
    const accepted = await h.manager.call(
      {
        type: "new",
        agent: "worker",
        prompt: "do work",
        workspaceDir: workspace,
      },
      h.context,
    );
    expect(accepted).toMatchObject({ status: "queued" });
    expect(accepted).not.toHaveProperty("workspaceDir");
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed", output: "done" });
    });
    expect(h.prepareInputs).toHaveLength(1);
    expect(h.prepareInputs[0]?.cwd).toBe(parent);
    expect(h.createInputs).toHaveLength(1);
    expect(h.createInputs[0]?.cwd).toBe(workspace);
    expect(h.storeCwds.length).toBeGreaterThan(0);
    expect(h.storeCwds.every((cwd) => cwd === parent)).toBe(true);
    expect(h.cleanupCwds).toEqual([parent]);
    for (const snapshot of h.writes) {
      expect(snapshot).not.toHaveProperty("workspaceDir");
    }
    const output = await h.manager.output({
      session_id: "00000000-0000-001f",
    });
    expect(output).not.toHaveProperty("workspaceDir");
    expect(JSON.stringify(h.writes)).not.toContain("workspaceDir");
  });

  it.each([
    ["blank", "   "],
    ["relative", "relative/work"],
    ["missing", "no-such-directory"],
    ["file", "some-file"],
  ])(
    "rejects an invalid %s workspaceDir with no side effects",
    async (_label, kind) => {
      const parent = tempDir("pi-workspace-parent-");
      const workspace =
        kind === "relative"
          ? join("relative", "work")
          : kind === "missing"
            ? join(parent, "no-such-directory")
            : kind === "file"
              ? (() => {
                  const file = join(parent, "some-file");
                  writeFileSync(file, "data", "utf-8");
                  return file;
                })()
              : "   ";
      const h = harness(parent);
      const writesBefore = h.writes.length;
      const error = await h.manager
        .call(
          {
            type: "new",
            agent: "worker",
            prompt: "do work",
            workspaceDir: workspace,
          },
          h.context,
        )
        .then(
          () => {
            throw new Error("expected workspaceDir rejection");
          },
          (cause: unknown) => cause,
        );
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect((error as { message?: string }).message).toBe(
        "workspaceDir must be a non-blank absolute path to an existing directory.",
      );
      expect(JSON.stringify(error)).not.toContain("ENOENT");
      if (workspace.trim() !== "") {
        expect(JSON.stringify(error)).not.toContain(workspace);
      }
      expect(h.calls).not.toContain("allocate-id");
      expect(h.calls).not.toContain("prepare-extensions");
      expect(h.calls).not.toContain("create-child");
      expect(h.writes).toHaveLength(writesBefore);
      expect(h.manager.sessionStatus()).toEqual({
        active_sessions: [],
        recent_sessions: [],
      });
    },
  );
});

describe("workspaceDir resume and steer rejection", () => {
  it("rejects resume workspaceDir before session lookup with no mutation", async () => {
    const parent = tempDir("pi-workspace-parent-");
    const workspace = tempDir("pi-workspace-child-");
    const h = harness(parent);
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "do work" },
      h.context,
    );
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
          prompt: "again",
          workspaceDir: workspace,
        },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // Rejection precedes session lookup: even an unknown ID reports the same code.
    await expect(
      h.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-0030",
          prompt: "again",
          workspaceDir: workspace,
        },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(h.writes).toHaveLength(writesBefore);
    expect(h.calls.filter((call) => call === "prompt:again")).toHaveLength(0);
    expect(h.manager.getSnapshot("00000000-0000-001f")).toMatchObject({
      status: "completed",
      output: "done",
    });
  });

  it("rejects steer workspaceDir before session lookup with no mutation", async () => {
    const parent = tempDir("pi-workspace-parent-");
    const workspace = tempDir("pi-workspace-child-");
    let release!: (value: { output: string }) => void;
    const gate = new Promise<{ output: string }>((resolve) => {
      release = resolve;
    });
    const h = harness(parent, { promptImpl: () => gate });
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "do work" },
      h.context,
    );
    await vi.waitFor(() => expect(h.calls).toContain("prompt:do work"));
    const writesBefore = h.writes.length;

    await expect(
      h.manager.call(
        {
          type: "steer",
          session_id: "00000000-0000-001f",
          prompt: "redirect",
          workspaceDir: workspace,
        },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      h.manager.call(
        {
          type: "steer",
          session_id: "00000000-0000-0030",
          prompt: "redirect",
          workspaceDir: workspace,
        },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(h.writes).toHaveLength(writesBefore);
    expect(h.calls.filter((call) => call === "steer:redirect")).toHaveLength(0);

    release({ output: "done" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
  });
});
