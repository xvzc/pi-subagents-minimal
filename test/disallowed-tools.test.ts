import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentFileRef,
  parseAgentMetadata,
} from "../src/agents/metadata.js";
import { createAgentRegistry, toAgentSummary } from "../src/agents/registry.js";
import { agentListData, renderAgentList } from "../src/runtime/agent-list.js";
import type {
  ChildSessionCreateInput,
  ChildSessionFactory,
} from "../src/runtime/agent-runner.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import type { AgentDefinition } from "../src/types.js";

const REF: AgentFileRef = {
  source: "project",
  sourcePath: "/proj/.pi/agents/a.md",
};

function doc(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n# A\nBody.\n`;
}

function fakeModel(): Model<Api> {
  return {
    provider: "acme",
    id: "model",
    reasoning: true,
  } as unknown as Model<Api>;
}

function baseAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
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
    ...overrides,
  };
}

function harness(agent: AgentDefinition, extensionToolNames: string[] = []) {
  const createInputs: ChildSessionCreateInput[] = [];
  const calls: string[] = [];
  const baseKnown = ["read", "bash", "write"];
  const childFactory: ChildSessionFactory = {
    knownToolNames: baseKnown,
    async prepareExtensions() {
      calls.push("prepare");
      return {
        resourceLoader: {} as never,
        settingsManager: {} as never,
        knownToolNames: [...baseKnown, ...extensionToolNames],
        knownSkillNames: [],
        dispose() {
          calls.push("dispose-preparation");
        },
      };
    },
    async create(input) {
      createInputs.push(input);
      return {
        async prompt() {
          return { output: "done" };
        },
        async configure() {},
        async steer() {},
        async abort() {},
      };
    },
  };
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
    },
    childFactory,
    createStore: () => ({
      async writeSession() {},
      async loadSessions() {
        return { records: [], warnings: [] };
      },
    }),
    cleanup: async () => undefined,
    now: () => "2026-01-01T00:00:00.000Z",
    createId: () => "00000000-0000-0016",
  });
  const catalog = [fakeModel()];
  const context = {
    cwd: "/project",
    sessionManager: { getSessionId: () => "parent-session" },
    modelRegistry: {
      getAll: () => catalog,
      find: (provider: string, id: string) =>
        catalog.find((c) => c.provider === provider && c.id === id),
    } as unknown as ModelRegistry,
    model: fakeModel(),
    thinkingLevel: "medium",
  } as unknown as ExtensionContext;
  return { manager, context, createInputs, calls };
}

async function runTools(
  agent: AgentDefinition,
  extensionToolNames: string[] = [],
) {
  const h = harness(agent, extensionToolNames);
  await h.manager.call(
    { type: "new", agent: "worker", prompt: "do it" },
    h.context,
  );
  await vi.waitFor(() => expect(h.createInputs).toHaveLength(1));
  return h;
}

describe("disallowed_tools parsing", () => {
  it("parses an array, trims entries, and preserves order", () => {
    const result = parseAgentMetadata(
      doc("name: a\ndescription: d\ndisallowed_tools: [' bash ', write]"),
      REF,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.definition.disallowedTools).toEqual(["bash", "write"]);
  });

  it("normalizes omitted and explicit empty to []", () => {
    const omitted = parseAgentMetadata(doc("name: a\ndescription: d"), REF);
    expect(omitted.ok && omitted.definition.disallowedTools).toEqual([]);
    const empty = parseAgentMetadata(
      doc("name: a\ndescription: d\ndisallowed_tools: []"),
      REF,
    );
    expect(empty.ok && empty.definition.disallowedTools).toEqual([]);
  });

  it.each([
    ["string", "disallowed_tools: bash"],
    ["blank entry", "disallowed_tools: ['   ']"],
    ["empty entry", "disallowed_tools: ['']"],
    ["number entry", "disallowed_tools: [42]"],
    ["null entry", "disallowed_tools: [null]"],
    ["duplicate", "disallowed_tools: [bash, bash]"],
    ["duplicate after trim", "disallowed_tools: [bash, ' bash ']"],
  ])("rejects %s", (_label, field) => {
    const result = parseAgentMetadata(
      doc(`name: a\ndescription: d\n${field}`),
      REF,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.warning.message).toContain('"disallowed_tools"');
  });
});

describe("disallowed_tools registry preservation", () => {
  it("maps to public disallowed_tools and copies defensively", () => {
    const definition = baseAgent({ disallowedTools: ["bash"] });
    const summary = toAgentSummary(definition);
    expect(summary.disallowed_tools).toEqual(["bash"]);
    (summary.disallowed_tools as string[]).push("mutated");
    expect(definition.disallowedTools).toEqual(["bash"]);

    const omitted = toAgentSummary(baseAgent());
    expect(omitted.disallowed_tools).toEqual([]);
  });

  it("survives registry snapshot copies", () => {
    const registry = createAgentRegistry({ agentDir: "/nope", cwd: "/nope" });
    expect(registry.snapshot().definitions).toEqual([]);
    void registry;
  });
});

describe("disallowed_tools session runtime", () => {
  it("subtracts from an explicit allowed list (overlap valid)", async () => {
    const h = await runTools(
      baseAgent({
        tools: ["read", "bash", "write"],
        disallowedTools: ["bash"],
      }),
    );
    expect(h.createInputs[0]?.tools).toEqual(["read", "write"]);
  });

  it("denying everything forwards []", async () => {
    const h = await runTools(
      baseAgent({ tools: ["read"], disallowedTools: ["read"] }),
    );
    expect(h.createInputs[0]?.tools).toEqual([]);
  });

  it("leaves an empty tools list as []", async () => {
    const h = await runTools(
      baseAgent({ tools: [], disallowedTools: ["read"] }),
    );
    expect(h.createInputs[0]?.tools).toEqual([]);
  });

  it("deny-only grants nothing", async () => {
    const h = await runTools(baseAgent({ disallowedTools: ["bash"] }));
    expect(h.createInputs[0]?.tools).toEqual([]);
  });

  it("subtracts from true all-selection", async () => {
    const h = await runTools(
      baseAgent({ tools: true, disallowedTools: ["bash"] }),
    );
    expect(h.createInputs[0]?.tools).toEqual(["read", "write"]);
  });

  it("denies extension-provided tools", async () => {
    const h = await runTools(
      baseAgent({
        tools: ["read", "web_search"],
        extensions: ["npm:pi-web-access"],
        disallowedTools: ["web_search"],
      }),
      ["web_search"],
    );
    expect(h.createInputs[0]?.tools).toEqual(["read"]);
  });

  it("rejects unknown disallowed names before allocation with disposal", async () => {
    const h = harness(
      baseAgent({
        tools: ["read"],
        extensions: ["npm:pi-web-access"],
        disallowedTools: ["nope"],
      }),
      ["web_search"],
    );
    await expect(
      h.manager.call(
        { type: "new", agent: "worker", prompt: "do it" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(h.createInputs).toHaveLength(0);
    expect(h.calls).toContain("prepare");
    expect(h.calls.filter((c) => c === "dispose-preparation")).toHaveLength(1);
  });

  it("rejects unknown disallowed names without extensions before allocation", async () => {
    const h = harness(baseAgent({ disallowedTools: ["nope"] }));
    await expect(
      h.manager.call(
        { type: "new", agent: "worker", prompt: "do it" },
        h.context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(h.createInputs).toHaveLength(0);
  });
});

describe("disallowed_tools list behavior", () => {
  it("surfaces disallowed_tools in list data only when present", () => {
    const withDenial = agentListData({
      agents: [{ name: "a", source: "global", disallowed_tools: ["bash"] }],
    });
    expect(withDenial.agents[0]).toMatchObject({ disallowed_tools: ["bash"] });
    const omitted = agentListData({
      agents: [{ name: "a", source: "global" }],
    });
    expect(
      "disallowed_tools" in
        (omitted.agents[0] as unknown as Record<string, unknown>),
    ).toBe(false);
  });

  it("renders disallowed tools rows only when present", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as never;
    const rendered = renderAgentList(
      { agents: [{ name: "a", source: "global", disallowed_tools: ["bash"] }] },
      true,
      theme,
    )
      .render(200)
      .join("\n");
    expect(rendered).toContain("disallowed tools: bash");
    const omitted = renderAgentList(
      { agents: [{ name: "a", source: "global" }] },
      true,
      theme,
    )
      .render(200)
      .join("\n");
    expect(omitted).not.toContain("disallowed");
  });
});
