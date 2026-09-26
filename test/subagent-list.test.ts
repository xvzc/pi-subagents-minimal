/**
 * `subagent_list` tool contract tests (T3, S17-S18, A1, A4-A5).
 *
 * Boots the extension the way Pi does — no injected registry — against
 * isolated agent/cwd directories, so the default registry composition is
 * exercised hermetically. Covers empty output, full optional-field mapping,
 * tools omission vs `[]`, sorted enabled-only output, disabled higher
 * overrides, warning presence/absence, leakage, activation-scoped snapshots,
 * injected-service passthrough, and the exact four-tool surface.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension, { TOOL_NAMES } from "../src/index.js";
import { SubagentListSchema } from "../src/schemas.js";
import type { ToolServices } from "../src/types.js";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: any, context: ExtensionContext) => unknown;

interface Fixture {
  root: string;
  agentDir: string;
  cwd: string;
  globalDir: string;
  sharedDir: string;
  piDir: string;
}

const fixtures: Fixture[] = [];

function useFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-minimal-list-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const fixture = {
    root,
    agentDir,
    cwd,
    globalDir: join(agentDir, "agents"),
    sharedDir: join(cwd, ".agents", "agents"),
    piDir: join(cwd, ".pi", "agents"),
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop()!.root, { recursive: true, force: true });
  }
});

/** Boot the extension with isolated config/agent paths, like Pi activation. */
async function boot(
  fixture: Fixture,
  services?: Partial<ToolServices>,
): Promise<AnyTool[]> {
  return (await bootWithHandlers(fixture, services)).tools;
}

async function bootWithHandlers(
  fixture: Fixture,
  services?: Partial<ToolServices>,
): Promise<{ tools: AnyTool[]; handlers: Map<string, Handler[]> }> {
  const tools: AnyTool[] = [];
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool: (tool: AnyTool) => {
      tools.push(tool);
    },
    on: (name: string, handler: Handler) => {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
  } as unknown as ExtensionAPI;
  await extension(pi, services, {
    agentDir: fixture.agentDir,
    cwd: fixture.cwd,
  });
  return { tools, handlers };
}

function listTool(tools: AnyTool[]): AnyTool {
  const tool = tools.find((candidate) => candidate.name === "subagent_list");
  expect(tool).toBeDefined();
  return tool!;
}

async function callTool(tool: AnyTool, params: unknown = {}): Promise<unknown> {
  const result = await tool.execute(
    "call-1",
    params,
    undefined,
    undefined,
    {} as never,
  );
  const text = result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
  return JSON.parse(text) as unknown;
}

async function callList(tool: AnyTool, params: unknown = {}): Promise<unknown> {
  return callTool(tool, params);
}

/** Minimal valid agent document. */
function doc(
  name: string,
  description = `${name} does things.`,
  extra = "",
): string {
  return `---\nname: ${name}\ndescription: ${description}${extra}\n---\n# ${name}\nDo the thing.\n`;
}

function writeAgent(dir: string, file: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("tool surface", () => {
  it("keeps the exact four public tools on normal activation", async () => {
    const names = (await boot(useFixture())).map((tool) => tool.name);
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

  it("keeps `subagent_list` input as `{}`", () => {
    expect(Value.Check(SubagentListSchema, {})).toBe(true);
    expect(SubagentListSchema).toMatchObject({ type: "object" });
  });
});

describe("empty registry", () => {
  it("returns `{ agents: [] }` with no warnings key instead of an unbound error", async () => {
    const body = (await callList(listTool(await boot(useFixture())))) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ agents: [] });
    expect("warnings" in body).toBe(false);
    expect("error" in body).toBe(false);
  });
});

describe("summaries", () => {
  it("maps every optional field and keeps the exact public key set", async () => {
    const fixture = useFixture();
    writeAgent(
      fixture.globalDir,
      "full.md",
      "---\nname: full\ndescription: All fields.\nmodel: opus\nthinking: high\ntools: [read, write]\nextensions: [npm:pi-web-access, path:extensions/pi-web-access]\nmax_turns: 10\n---\n# full\nBody.\n",
    );
    const body = (await callList(listTool(await boot(fixture)))) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(body.agents).toEqual([
      {
        name: "full",
        description: "All fields.",
        model: "opus",
        thinking: "high",
        tools: ["read", "write"],
        disallowed_tools: [],
        skills: [],
        disallowed_skills: [],
        extensions: ["npm:pi-web-access", "path:extensions/pi-web-access"],
        max_turns: 10,
        source: "global",
      },
    ]);
  });

  it("normalizes omitted capabilities while preserving extension omission", async () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("aaa", "Omitted tools."));
    writeAgent(
      fixture.globalDir,
      "b.md",
      "---\nname: bbb\ndescription: No tools or extensions.\ntools: []\nextensions: []\n---\n# bbb\nBody.\n",
    );
    const body = (await callList(listTool(await boot(fixture)))) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(body.agents.map((agent) => agent.name)).toEqual(["aaa", "bbb"]);
    expect(body.agents[0]).toMatchObject({
      tools: [],
      disallowed_tools: [],
      skills: [],
      disallowed_skills: [],
    });
    expect("extensions" in (body.agents[0] as Record<string, unknown>)).toBe(
      false,
    );
    expect(body.agents[1]).toMatchObject({ tools: [], extensions: [] });
  });

  it("returns only enabled definitions sorted by case-sensitive name", async () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "z.md", doc("Zebra"));
    writeAgent(fixture.globalDir, "a.md", doc("alpha"));
    writeAgent(fixture.globalDir, "b.md", doc("Beta"));
    writeAgent(
      fixture.globalDir,
      "off.md",
      "---\nname: aardvark\ndescription: Off.\nenabled: false\n---\n# aardvark\nOff.\n",
    );
    const body = (await callList(listTool(await boot(fixture)))) as {
      agents: Array<{ name: string }>;
    };
    // Code-unit order: uppercase before lowercase.
    expect(body.agents.map((agent) => agent.name)).toEqual([
      "Beta",
      "Zebra",
      "alpha",
    ]);
  });

  it("hides a lower definition behind a disabled higher-precedence override", async () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("dup", "Global."));
    writeAgent(
      fixture.piDir,
      "off.md",
      "---\nname: dup\ndescription: Disabled.\nenabled: false\n---\n# dup\nOff.\n",
    );
    const body = (await callList(listTool(await boot(fixture)))) as {
      agents: unknown[];
    };
    expect(body.agents).toEqual([]);
    expect("warnings" in (body as Record<string, unknown>)).toBe(false);
  });
});

describe("warnings", () => {
  it("omits warnings when every file is valid", async () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("ok"));
    const body = (await callList(listTool(await boot(fixture)))) as Record<
      string,
      unknown
    >;
    expect(body.agents).toHaveLength(1);
    expect("warnings" in body).toBe(false);
  });

  it("includes only `{ path, message }` warnings alongside valid agents", async () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "good.md", doc("good"));
    writeAgent(fixture.globalDir, "bad.md", "---\nname: bad\n---\n");
    const body = (await callList(listTool(await boot(fixture)))) as {
      agents: Array<{ name: string }>;
      warnings: Array<Record<string, unknown>>;
    };
    expect(body.agents.map((agent) => agent.name)).toEqual(["good"]);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toEqual({
      path: join(fixture.globalDir, "bad.md"),
      message: expect.any(String),
    });
    expect(
      Object.keys(body.warnings[0] as Record<string, unknown>).sort(),
    ).toEqual(["message", "path"]);
  });
});

describe("leakage", () => {
  it("never exposes prompts, paths, enabled, raw frontmatter, or unknown keys", async () => {
    const fixture = useFixture();
    const promptSecret = "prompt-secret-token-list-abc123";
    const unknownSecret = "unknown-field-secret-list-def456";
    writeAgent(
      fixture.sharedDir,
      "guarded.md",
      `---\nname: guarded\ndescription: Guarded agent.\nmodel: opus\nmemory: ${unknownSecret}\n---\n# guarded\n${promptSecret}\n`,
    );
    const tool = listTool(await boot(fixture));
    const body = (await callList(tool)) as {
      agents: Array<Record<string, unknown>>;
    };
    expect(body.agents).toHaveLength(1);
    const agent = body.agents[0] as Record<string, unknown>;
    expect(Object.keys(agent).sort()).toEqual(
      [
        "description",
        "disallowed_skills",
        "disallowed_tools",
        "model",
        "name",
        "skills",
        "source",
        "tools",
      ].sort(),
    );
    expect(agent.source).toBe("project");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(promptSecret);
    expect(serialized).not.toContain(unknownSecret);
    expect(serialized).not.toContain("systemPrompt");
    expect(serialized).not.toContain("sourcePath");
    expect(serialized).not.toContain("enabled");
    expect(serialized).not.toContain("memory");
    expect(serialized).not.toContain(fixture.sharedDir);
  });
});

describe("activation snapshots and injection", () => {
  it("keeps repeated calls stable and refreshes only after reactivation", async () => {
    const fixture = useFixture();
    const firstActivation = listTool(await boot(fixture));
    expect(await callList(firstActivation)).toEqual({ agents: [] });

    writeAgent(fixture.globalDir, "fresh.md", doc("fresh"));
    expect(await callList(firstActivation)).toEqual({ agents: [] });

    const secondActivation = listTool(await boot(fixture));
    expect(await callList(secondActivation)).toEqual({
      agents: [
        {
          name: "fresh",
          description: "fresh does things.",
          tools: [],
          disallowed_tools: [],
          skills: [],
          disallowed_skills: [],
          source: "global",
        },
      ],
    });

    rmSync(join(fixture.globalDir, "fresh.md"), { force: true });
    expect(
      ((await callList(secondActivation)) as { agents: unknown[] }).agents,
    ).toHaveLength(1);
    expect(await callList(listTool(await boot(fixture)))).toEqual({
      agents: [],
    });
  });

  it("does not refresh the activation snapshot on session_start", async () => {
    const fixture = useFixture();
    const file = writeAgent(
      fixture.globalDir,
      "agent.md",
      doc("alpha", "Alpha."),
    );
    const { tools, handlers } = await bootWithHandlers(fixture);
    expect(
      ((await callList(listTool(tools))) as { agents: Array<{ name: string }> })
        .agents,
    ).toEqual([
      {
        name: "alpha",
        description: "Alpha.",
        tools: [],
        disallowed_tools: [],
        skills: [],
        disallowed_skills: [],
        source: "global",
      },
    ]);

    writeFileSync(file, doc("beta", "Beta."), "utf-8");
    const context = {
      cwd: fixture.cwd,
      sessionManager: { getSessionId: () => "parent-session" },
    } as unknown as ExtensionContext;
    await handlers.get("session_start")?.[0]?.({}, context);

    expect(
      ((await callList(listTool(tools))) as { agents: Array<{ name: string }> })
        .agents,
    ).toEqual([
      {
        name: "alpha",
        description: "Alpha.",
        tools: [],
        disallowed_tools: [],
        skills: [],
        disallowed_skills: [],
        source: "global",
      },
    ]);
    expect(
      (
        (await callList(listTool(await boot(fixture)))) as {
          agents: Array<{ name: string }>;
        }
      ).agents,
    ).toEqual([
      {
        name: "beta",
        description: "Beta.",
        tools: [],
        disallowed_tools: [],
        skills: [],
        disallowed_skills: [],
        source: "global",
      },
    ]);
  });

  it("keeps registry and session service injection independent", async () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "filesystem.md", doc("filesystem"));
    const sessions = {
      call: vi.fn(async () => ({ owner: "injected-sessions" })),
      output: vi.fn(async () => ({ owner: "injected-sessions" })),
      shutdown: vi.fn(async () => undefined),
    };

    const sessionsOnly = await boot(fixture, { sessions });
    expect(
      (
        (await callList(listTool(sessionsOnly))) as {
          agents: Array<{ name: string }>;
        }
      ).agents,
    ).toEqual([
      {
        name: "filesystem",
        description: "filesystem does things.",
        tools: [],
        disallowed_tools: [],
        skills: [],
        disallowed_skills: [],
        source: "global",
      },
    ]);
    const call = sessionsOnly.find((tool) => tool.name === "subagent_call")!;
    expect(
      await callTool(call, { type: "new", agent: "ignored", prompt: "x" }),
    ).toEqual({ owner: "injected-sessions" });

    const registryPayload = {
      agents: [
        { name: "injected", description: "Injected.", source: "global" },
      ],
    };
    const combined = await boot(fixture, {
      sessions,
      registry: { list: async () => registryPayload },
    });
    expect(await callList(listTool(combined))).toEqual(registryPayload);
    expect(
      await callTool(
        combined.find((tool) => tool.name === "subagent_call")!,
        { type: "new", agent: "ignored", prompt: "x" },
      ),
    ).toEqual({ owner: "injected-sessions" });
  });

  it("honors an explicitly injected registry service instead of the default", async () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "filesystem.md", doc("filesystem"));
    const injected = {
      agents: [
        { name: "injected", description: "Injected.", source: "global" },
      ],
    };
    const tools = await boot(fixture, {
      registry: {
        list: async () => injected,
      },
    });
    const body = await callList(listTool(tools));
    expect(body).toEqual(injected);
    expect(JSON.stringify(body)).not.toContain("filesystem");
  });
});
