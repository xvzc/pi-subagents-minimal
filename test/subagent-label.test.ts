import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { SubagentCallSchema } from "../src/schemas.js";
import { deriveLabel } from "../src/runtime/agents-view.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import type { AgentDefinition } from "../src/types.js";

function fakeModel(): Model<Api> {
  return {
    provider: "acme",
    id: "model",
    reasoning: true,
  } as unknown as Model<Api>;
}

const agent: AgentDefinition = {
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
    promptImpl?: (
      prompt: string,
      progress?: (observation: never) => void,
    ) => Promise<{ output: string }>;
    createIds?: string[];
    writeImpl?: (snapshot: { status: string }, count: number) => Promise<void>;
  } = {},
) {
  const writes: unknown[] = [];
  let writeCount = 0;
  const model = fakeModel();
  const manager = new SessionManager({
    config: {
      historyRetentionDays: 7,
      maxConcurrentSubagents: 8,
      injectGuidelines: true,
    },
    agentDir: "/agent-dir",
    registry: {
      snapshot: () => ({ definitions: [], warnings: [] }),
      listCandidates: () => ({ definitions: [], warnings: [] }),
      findForSession: (name: string) =>
        name === agent.name ? agent : undefined,
      findCurrent: (name: string) => (name === agent.name ? agent : undefined),
    } as never,
    childFactory: {
      async prepareExtensions() {
        return {
          resourceLoader: {},
          settingsManager: {},
          knownToolNames: ["read"],
          knownSkillNames: [],
          dispose() {},
        } as never;
      },
      async create() {
        return {
          async prompt(prompt: string) {
            if (options.promptImpl) return options.promptImpl(prompt);
            return { output: "done" };
          },
          async configure() {},
          async steer() {},
          async abort() {},
          dispose() {},
        } as never;
      },
    } as never,
    createStore: () => ({
      async writeSession(snapshot: never) {
        writeCount += 1;
        await options.writeImpl?.(
          snapshot as unknown as { status: string },
          writeCount,
        );
        writes.push(structuredClone(snapshot));
      },
      async loadSessions() {
        return { records: [], warnings: [] };
      },
    }),
    cleanup: async () => undefined,
    now: () => "2026-01-01T00:00:00.000Z",
    createId: () => options.createIds?.shift() ?? "00000000-0000-001f",
  });
  const context = {
    cwd: "/project",
    sessionManager: { getSessionId: () => "parent-session" },
    modelRegistry: {
      getAll: () => [model],
      find: (provider: string, id: string) =>
        provider === "acme" && id === "model" ? model : undefined,
    } as unknown as ModelRegistry,
    model,
    thinkingLevel: "medium",
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  return { manager, context, writes };
}

function taskLabelOf(manager: SessionManager, id: string): unknown {
  const records = manager as unknown as {
    records: Map<string, Record<string, unknown>>;
  };
  return records.records.get(id)?.["taskLabel"];
}

describe("subagent label", () => {
  it("declares an optional label with concise-task guidance", () => {
    const schema = SubagentCallSchema.properties.label as
      { description?: string } | undefined;
    expect(schema?.description).toBeTypeOf("string");
    expect(schema?.description).toContain("concisely as possible");
    expect(
      Value.Check(SubagentCallSchema, {
        type: "new",
        agent: "worker",
        prompt: "do it",
      }),
    ).toBe(true);
    expect(
      Value.Check(SubagentCallSchema, {
        type: "new",
        agent: "worker",
        prompt: "do it",
        label: "short name",
      }),
    ).toBe(true);
  });

  it("uses the supplied label for new and falls back to the prompt when omitted", async () => {
    const h = harness();
    await h.manager.call(
      {
        type: "new",
        agent: "worker",
        prompt: "  do it  ",
        label: "  Custom   Task  ",
      } as never,
      h.context,
    );
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe("Custom Task");

    const fallback = harness({ createIds: ["00000000-0000-0020"] });
    await fallback.manager.call(
      {
        type: "new",
        agent: "worker",
        prompt: "\n  many   words here\nignored",
      } as never,
      fallback.context,
    );
    expect(taskLabelOf(fallback.manager, "00000000-0000-0020")).toBe(
      deriveLabel("\n  many   words here\nignored"),
    );
  });

  it("normalizes labels with the existing display rules", async () => {
    const h = harness();
    const long = "x".repeat(61);
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "do it", label: long } as never,
      h.context,
    );
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe(
      deriveLabel(long),
    );
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe(
      `${"x".repeat(59)}…`,
    );
  });

  it("rejects a blank label for new and resume", async () => {
    const h = harness();
    for (const label of ["", "   "]) {
      await expect(
        h.manager.call(
          { type: "new", agent: "worker", prompt: "do it", label } as never,
          h.context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "do it" } as never,
      h.context,
    );
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    for (const label of ["", "   "]) {
      await expect(
        h.manager.call(
          {
            type: "resume",
            session_id: "00000000-0000-001f",
            prompt: "again",
            label,
          } as never,
          h.context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("updates the label on resume and falls back to the prompt when omitted", async () => {
    const h = harness();
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "original work" } as never,
      h.context,
    );
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    await h.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-001f",
        prompt: "continued work",
        label: "resumed name",
      } as never,
      h.context,
    );
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe("resumed name");
    await vi.waitFor(async () => {
      const output = (await h.manager.output({
        session_id: "00000000-0000-001f",
      })) as Record<string, unknown>;
      expect(output["status"]).toBe("completed");
      expect(output).not.toHaveProperty("label");
    });
    expect(h.manager.getSnapshot("00000000-0000-001f")).not.toHaveProperty(
      "label",
    );

    const second = harness({ createIds: ["00000000-0000-0020"] });
    await second.manager.call(
      { type: "new", agent: "worker", prompt: "original work" } as never,
      second.context,
    );
    await vi.waitFor(async () => {
      expect(
        await second.manager.output({ session_id: "00000000-0000-0020" }),
      ).toMatchObject({ status: "completed" });
    });
    await second.manager.call(
      {
        type: "resume",
        session_id: "00000000-0000-0020",
        prompt: "second line here",
      } as never,
      second.context,
    );
    expect(taskLabelOf(second.manager, "00000000-0000-0020")).toBe(
      deriveLabel("second line here"),
    );
  });

  it("validates resume labels only after session visibility and state checks", async () => {
    // Unknown session with a blank label stays SESSION_NOT_FOUND (S7).
    const unknown = harness();
    await expect(
      unknown.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-00ff",
          prompt: "again",
          label: "   ",
        } as never,
        unknown.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });

    // Cross-namespace session with a blank label is not disclosed (S7).
    const h = harness();
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "original work" } as never,
      h.context,
    );
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    const other = {
      ...h.context,
      cwd: "/other-project",
      sessionManager: { getSessionId: () => "other-parent" },
    } as unknown as ExtensionContext;
    await expect(
      h.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-001f",
          prompt: "again",
          label: "",
        } as never,
        other,
      ),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });

    // Busy (running) session with a blank label stays SESSION_BUSY.
    let release!: (value: { output: string }) => void;
    const gate = new Promise<{ output: string }>((resolve) => {
      release = resolve;
    });
    const busy = harness({ promptImpl: () => gate });
    await busy.manager.call(
      { type: "new", agent: "worker", prompt: "original work" } as never,
      busy.context,
    );
    await vi.waitFor(() => {
      expect(busy.manager.getSnapshot("00000000-0000-001f")?.status).toBe(
        "running",
      );
    });
    await expect(
      busy.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-001f",
          prompt: "again",
          label: "   ",
        } as never,
        busy.context,
      ),
    ).rejects.toMatchObject({ code: "SESSION_BUSY" });
    release({ output: "done" });
    await vi.waitFor(async () => {
      expect(
        await busy.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
  });

  it("restores the prior widget label when a resume queued write fails", async () => {
    let failResumeQueued = false;
    const h = harness({
      writeImpl: async (snapshot) => {
        if (failResumeQueued && snapshot.status === "queued") {
          throw new Error("queued write failed");
        }
      },
    });
    await h.manager.call(
      {
        type: "new",
        agent: "worker",
        prompt: "original work",
        label: "original label",
      } as never,
      h.context,
    );
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe("original label");
    failResumeQueued = true;
    await expect(
      h.manager.call(
        {
          type: "resume",
          session_id: "00000000-0000-001f",
          prompt: "replacement work",
          label: "replacement label",
        } as never,
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe("original label");
    expect(
      await h.manager.output({ session_id: "00000000-0000-001f" }),
    ).toMatchObject({ status: "completed", output: "done" });
  });

  it("silently ignores steer labels without updating the widget label", async () => {
    let release!: (value: { output: string }) => void;
    const gate = new Promise<{ output: string }>((resolve) => {
      release = resolve;
    });
    const h = harness({ promptImpl: () => gate });
    await h.manager.call(
      {
        type: "new",
        agent: "worker",
        prompt: "original work",
        label: "original",
      } as never,
      h.context,
    );
    await vi.waitFor(() => {
      expect(h.manager.getSnapshot("00000000-0000-001f")?.status).toBe(
        "running",
      );
    });
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe("original");
    for (const label of ["ignored", ""]) {
      const result = await h.manager.call(
        {
          type: "steer",
          session_id: "00000000-0000-001f",
          prompt: "nudge",
          label,
        } as never,
        h.context,
      );
      expect(result).toMatchObject({
        session_id: "00000000-0000-001f",
        status: "running",
        steered: true,
      });
    }
    expect(taskLabelOf(h.manager, "00000000-0000-001f")).toBe("original");
    release({ output: "done" });
    await vi.waitFor(async () => {
      expect(
        await h.manager.output({ session_id: "00000000-0000-001f" }),
      ).toMatchObject({ status: "completed" });
    });
  });
});
