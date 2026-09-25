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
import type {
  ChildSessionCreateInput,
  ChildSessionFactory,
} from "../src/runtime/agent-runner.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import type { AgentDefinition } from "../src/types.js";

const REF: AgentFileRef = {
  source: "project",
  sourcePath: "/proj/.pi/agents/capabilities.md",
};

function doc(frontmatter: string): string {
  return `---\n${frontmatter}\n---\nBody.\n`;
}

function fakeModel(): Model<Api> {
  return { provider: "acme", id: "model", reasoning: true } as Model<Api>;
}

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "worker",
    description: "Worker.",
    tools: [],
    disallowedTools: [],
    skills: [],
    disallowedSkills: [],
    enabled: true,
    systemPrompt: "Child prompt.",
    source: "project",
    sourcePath: "/agents/worker.md",
    ...overrides,
  };
}

function harness(definition: AgentDefinition) {
  const createInputs: ChildSessionCreateInput[] = [];
  const calls: string[] = [];
  const childFactory: ChildSessionFactory = {
    knownToolNames: ["read", "bash"],
    async prepareExtensions() {
      calls.push("prepare");
      return {
        resourceLoader: {} as never,
        settingsManager: {} as never,
        knownToolNames: ["read", "bash", "web_search"],
        knownSkillNames: ["review", "deploy"],
        dispose() {
          calls.push("dispose");
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
      findForSession: () => definition,
      findCurrent: () => definition,
    },
    childFactory,
    createStore: () => ({ async writeSession() {} }),
    cleanup: async () => undefined,
    createId: () => "00000000-0000-0012",
  });
  const model = fakeModel();
  const context = {
    cwd: "/project",
    sessionManager: { getSessionId: () => "parent" },
    modelRegistry: {
      getAll: () => [model],
      find: () => model,
    } as unknown as ModelRegistry,
    model,
    thinkingLevel: "medium",
  } as ExtensionContext;
  return { manager, context, createInputs, calls };
}

describe("capability metadata", () => {
  it("normalizes omitted policies and accepts booleans and trimmed lists", () => {
    const omitted = parseAgentMetadata(doc("name: a\ndescription: d"), REF);
    expect(omitted.ok && omitted.definition).toMatchObject({
      tools: [],
      disallowedTools: [],
      skills: [],
      disallowedSkills: [],
    });

    const selected = parseAgentMetadata(
      doc(
        "name: a\ndescription: d\ntools: true\nskills: [' review ']\ndisallowed_tools: [bash]\ndisallowed_skills: [deploy]",
      ),
      REF,
    );
    expect(selected.ok && selected.definition).toMatchObject({
      tools: true,
      skills: ["review"],
      disallowedTools: ["bash"],
      disallowedSkills: ["deploy"],
    });
  });

  it.each([
    ["null", "tools: null"],
    ["quoted wildcard", 'tools: "*"'],
    ["blank", "skills: ['   ']"],
    ["duplicate", "skills: [review, ' review ']"],
    ["deny scalar", "disallowed_tools: true"],
    ["deny duplicate", "disallowed_skills: [review, review]"],
  ])("rejects invalid %s", (_label, field) => {
    const result = parseAgentMetadata(
      doc(`name: a\ndescription: d\n${field}`),
      REF,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects bare YAML wildcard as invalid YAML", () => {
    expect(
      parseAgentMetadata(doc("name: a\ndescription: d\ntools: *"), REF).ok,
    ).toBe(false);
  });

  it("does not give wildcard strings special list semantics", () => {
    const result = parseAgentMetadata(
      doc("name: a\ndescription: d\ntools: ['*']"),
      REF,
    );
    expect(result.ok && result.definition.tools).toEqual(["*"]);
  });

  it.each(["tools", "skills"])(
    "accepts every valid allow-policy shape for %s",
    (field) => {
      for (const [yaml, expected] of [
        [`${field}: []`, []],
        [`${field}: false`, []],
        [`${field}: true`, true],
        [`${field}: [' first ', second]`, ["first", "second"]],
      ] as const) {
        const result = parseAgentMetadata(
          doc(`name: a\ndescription: d\n${yaml}`),
          REF,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          const value =
            field === "tools"
              ? result.definition.tools
              : result.definition.skills;
          expect(value).toEqual(expected);
        }
      }
    },
  );

  it.each(["disallowed_tools", "disallowed_skills"])(
    "accepts every valid deny-policy shape for %s",
    (field) => {
      for (const [yaml, expected] of [
        [`${field}: []`, []],
        [`${field}: [' first ', second]`, ["first", "second"]],
      ] as const) {
        const result = parseAgentMetadata(
          doc(`name: a\ndescription: d\n${yaml}`),
          REF,
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          const value =
            field === "disallowed_tools"
              ? result.definition.disallowedTools
              : result.definition.disallowedSkills;
          expect(value).toEqual(expected);
        }
      }
    },
  );

  it.each(["tools", "skills"])(
    "rejects every invalid allow-policy class for %s with a field warning",
    (field) => {
      for (const value of [
        "null",
        "'*'",
        "[true]",
        "[42]",
        "[null]",
        "['']",
        "['   ']",
        "[name, name]",
        "[name, ' name ']",
      ]) {
        expect(
          parseAgentMetadata(
            doc(`name: a\ndescription: d\n${field}: ${value}`),
            REF,
          ),
        ).toEqual({
          ok: false,
          warning: {
            path: REF.sourcePath,
            message: `invalid "${field}": expected a boolean or an array of unique non-empty strings`,
          },
        });
      }
    },
  );

  it.each(["disallowed_tools", "disallowed_skills"])(
    "rejects every invalid deny-policy class for %s with a field warning",
    (field) => {
      for (const value of [
        "true",
        "false",
        "null",
        "'*'",
        "[true]",
        "[42]",
        "[null]",
        "['']",
        "['   ']",
        "[name, name]",
        "[name, ' name ']",
      ]) {
        expect(
          parseAgentMetadata(
            doc(`name: a\ndescription: d\n${field}: ${value}`),
            REF,
          ),
        ).toEqual({
          ok: false,
          warning: {
            path: REF.sourcePath,
            message: `invalid "${field}": expected an array of unique non-empty strings`,
          },
        });
      }
    },
  );

  it.each(["tools", "skills", "disallowed_tools", "disallowed_skills"])(
    "rejects bare YAML wildcard for %s before field parsing",
    (field) => {
      expect(
        parseAgentMetadata(doc(`name: a\ndescription: d\n${field}: *`), REF),
      ).toEqual({
        ok: false,
        warning: {
          path: REF.sourcePath,
          message: "invalid frontmatter: expected valid YAML",
        },
      });
    },
  );
});

describe("capability runtime resolution", () => {
  it("defaults tools and skills to none", async () => {
    const h = harness(agent());
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "go" },
      h.context,
    );
    await vi.waitFor(() => expect(h.createInputs).toHaveLength(1));
    expect(h.createInputs[0]).toMatchObject({ tools: [], skills: [] });
  });

  it("resolves all and subtracts deny policies in catalog order", async () => {
    const h = harness(
      agent({
        tools: true,
        disallowedTools: ["bash"],
        skills: true,
        disallowedSkills: ["deploy"],
      }),
    );
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "go" },
      h.context,
    );
    await vi.waitFor(() => expect(h.createInputs).toHaveLength(1));
    expect(h.createInputs[0]?.tools).toEqual(["read", "web_search"]);
    expect(h.createInputs[0]?.skills).toEqual(["review"]);
  });

  it("keeps explicit declaration order and deny-only grants nothing", async () => {
    const h = harness(
      agent({
        tools: ["web_search", "read"],
        disallowedTools: ["read"],
        disallowedSkills: ["deploy"],
      }),
    );
    await h.manager.call(
      { type: "new", agent: "worker", prompt: "go" },
      h.context,
    );
    await vi.waitFor(() => expect(h.createInputs).toHaveLength(1));
    expect(h.createInputs[0]?.tools).toEqual(["web_search"]);
    expect(h.createInputs[0]?.skills).toEqual([]);
  });

  it.each([
    { tools: ["missing"] },
    { disallowedTools: ["missing"] },
    { skills: ["missing"] },
    { disallowedSkills: ["missing"] },
  ])(
    "rejects unknown explicit policies after allocation and disposes",
    async (policy) => {
      let allocated = false;
      const h = harness(agent(policy));
      (h.manager as unknown as { createId: () => string }).createId = () => {
        allocated = true;
        return "00000000-0000-000f";
      };
      await expect(
        h.manager.call(
          { type: "new", agent: "worker", prompt: "go" },
          h.context,
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(allocated).toBe(true);
      expect(h.calls).toEqual(["prepare", "dispose"]);
    },
  );
});
