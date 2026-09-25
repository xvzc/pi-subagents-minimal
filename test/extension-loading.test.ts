import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRegistry,
  ModelRuntime,
  SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiChildSessionFactory,
  filterSkills,
} from "../src/runtime/agent-runner.js";

const roots: string[] = [];

function writeExtension(directory: string, toolName: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "index.js"),
    `export default (pi) => pi.registerTool({
      name: ${JSON.stringify(toolName)},
      label: ${JSON.stringify(toolName)},
      description: "fixture",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "ok" }] }; }
    });\n`,
  );
}

function writeSkill(
  directory: string,
  name: string,
  description: string,
  body: string,
): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
  return path;
}

function writeResourceExtension(directory: string, skillPath: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "index.js"),
    `export default (pi) => pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(skillPath)}] }));\n`,
  );
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Pi 0.84.2 explicit extension isolation", () => {
  it("loads an additional path with noExtensions while excluding ambient extensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-extension-loading-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    writeExtension(join(cwd, ".pi", "extensions", "selected"), "selected_tool");
    writeExtension(join(agentDir, "extensions", "ambient"), "ambient_tool");

    const prepared = await createPiChildSessionFactory().prepareExtensions!({
      cwd,
      agentDir,
      systemPrompt: "Child prompt.",
      extensions: ["path:extensions/selected"],
    });

    expect(prepared.knownToolNames).toContain("selected_tool");
    expect(prepared.knownToolNames).not.toContain("ambient_tool");
    const loaded = prepared.resourceLoader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
  });

  it("loads ambient, project, and selected-extension skills into the post-load catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-skill-catalog-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    writeSkill(
      join(agentDir, "skills", "ambient"),
      "ambient",
      "Ambient skill.",
      "AMBIENT_BODY",
    );
    writeSkill(
      join(cwd, ".pi", "skills", "project"),
      "project",
      "Project skill.",
      "PROJECT_BODY",
    );
    const selectedSkill = writeSkill(
      join(root, "selected-skill"),
      "selected",
      "Selected extension skill.",
      "SELECTED_BODY",
    );
    writeResourceExtension(
      join(cwd, ".pi", "extensions", "selected"),
      selectedSkill,
    );

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const prepared = await createPiChildSessionFactory().prepareExtensions!({
      cwd,
      agentDir,
      systemPrompt: "Child prompt.",
      extensions: ["path:extensions/selected"],
      modelRegistry: new ModelRegistry(modelRuntime),
    });

    expect(prepared.knownSkillNames).toEqual(
      expect.arrayContaining(["ambient", "project", "selected"]),
    );
    prepared.dispose();
  });

  it("filters real Pi prompt and skill-command lookup through the resource loader", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-skill-filter-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    writeSkill(
      join(agentDir, "skills", "allowed"),
      "allowed",
      "ALLOWED_DESCRIPTION_MARKER",
      "ALLOWED_BODY_MARKER",
    );
    writeSkill(
      join(agentDir, "skills", "denied"),
      "denied",
      "DENIED_DESCRIPTION_MARKER",
      "DENIED_BODY_MARKER",
    );
    const prepared = await createPiChildSessionFactory().prepareExtensions!({
      cwd,
      agentDir,
      systemPrompt: "Child prompt.",
      extensions: [],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = {
      provider: "fixture",
      id: "model",
      reasoning: false,
    } as unknown as Model<Api>;
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      tools: ["read"],
      resourceLoader: filterSkills(prepared.resourceLoader, ["allowed"]),
      settingsManager: prepared.settingsManager,
      sessionManager: PiSessionManager.inMemory(cwd),
    });

    expect(session.systemPrompt).toContain("ALLOWED_DESCRIPTION_MARKER");
    expect(session.systemPrompt).not.toContain("DENIED_DESCRIPTION_MARKER");
    const expandSkill = (
      session as unknown as { _expandSkillCommand(text: string): string }
    )._expandSkillCommand.bind(session);
    expect(expandSkill("/skill:allowed extra")).toContain(
      "ALLOWED_BODY_MARKER",
    );
    expect(expandSkill("/skill:denied extra")).toBe("/skill:denied extra");
    session.dispose();
    prepared.dispose();
  });

  it("rejects a manifest escape before an escaped factory can execute", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagents-extension-preimport-"),
    );
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const extensionsDir = join(cwd, ".pi", "extensions");
    const selected = join(extensionsDir, "selected");
    const sentinel = join(root, "escaped-factory-executed");
    mkdirSync(selected, { recursive: true });
    writeFileSync(
      join(extensionsDir, "outside.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default () => {};\n`,
    );
    writeFileSync(
      join(selected, "package.json"),
      JSON.stringify({ pi: { extensions: ["../outside.js"] } }),
    );

    await expect(
      createPiChildSessionFactory().prepareExtensions!({
        cwd,
        agentDir,
        systemPrompt: "Child prompt.",
        extensions: ["path:extensions/selected"],
      }),
    ).rejects.toThrow();
    expect(existsSync(sentinel)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a nested entrypoint symlink escape before factory execution",
    async () => {
      const root = mkdtempSync(
        join(tmpdir(), "pi-subagents-extension-entry-symlink-"),
      );
      roots.push(root);
      const cwd = join(root, "project");
      const agentDir = join(root, "agent");
      const selected = join(cwd, ".pi", "extensions", "selected");
      const outside = join(root, "outside.js");
      const sentinel = join(root, "symlink-factory-executed");
      mkdirSync(join(selected, "entries"), { recursive: true });
      writeFileSync(
        outside,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default () => {};\n`,
      );
      symlinkSync(outside, join(selected, "entries", "escaped.js"));
      writeFileSync(
        join(selected, "package.json"),
        JSON.stringify({ pi: { extensions: ["entries/*.js"] } }),
      );

      await expect(
        createPiChildSessionFactory().prepareExtensions!({
          cwd,
          agentDir,
          systemPrompt: "Child prompt.",
          extensions: ["path:extensions/selected"],
        }),
      ).rejects.toThrow();
      expect(existsSync(sentinel)).toBe(false);
    },
  );

  it("loads manifest glob matches without executing excluded factories", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagents-extension-glob-exclusion-"),
    );
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const selected = join(cwd, ".pi", "packages", "selected");
    const extensions = join(selected, "extensions");
    const sentinel = join(root, "excluded-factory-executed");
    mkdirSync(extensions, { recursive: true });
    writeExtension(join(extensions, "safe"), "glob_tool");
    writeFileSync(
      join(extensions, "excluded.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default () => {};\n`,
    );
    writeFileSync(
      join(selected, "package.json"),
      JSON.stringify({
        pi: {
          extensions: [
            "extensions/**/index.js",
            "extensions/*.js",
            "!extensions/excluded.js",
          ],
        },
      }),
    );

    const prepared = await createPiChildSessionFactory().prepareExtensions!({
      cwd,
      agentDir,
      systemPrompt: "Child prompt.",
      extensions: ["path:packages/selected"],
    });
    expect(prepared.knownToolNames).toContain("glob_tool");
    expect(existsSync(sentinel)).toBe(false);
    prepared.dispose();
  });

  it("does not import unrelated package-root scripts outside convention directories", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagents-extension-convention-"),
    );
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const selected = join(cwd, ".pi", "packages", "selected");
    const sentinel = join(root, "unrelated-script-executed");
    writeExtension(join(selected, "extensions", "safe"), "convention_tool");
    writeFileSync(
      join(selected, "build.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default () => {};\n`,
    );

    const prepared = await createPiChildSessionFactory().prepareExtensions!({
      cwd,
      agentDir,
      systemPrompt: "Child prompt.",
      extensions: ["path:packages/selected"],
    });
    expect(prepared.knownToolNames).toContain("convention_tool");
    expect(existsSync(sentinel)).toBe(false);
    prepared.dispose();
  });

  it("uses exact omitted, empty, and explicit active-tool semantics in a real Pi session", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagents-extension-active-tools-"),
    );
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    writeExtension(join(cwd, ".pi", "extensions", "selected"), "selected_tool");
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = {
      provider: "fixture",
      id: "model",
      reasoning: false,
    } as unknown as Model<Api>;

    const activeTools = async (
      tools: string[] | undefined,
    ): Promise<string[]> => {
      const prepared = await createPiChildSessionFactory().prepareExtensions!({
        cwd,
        agentDir,
        systemPrompt: "Child prompt.",
        extensions: ["path:extensions/selected"],
      });
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        thinkingLevel: "off",
        ...(tools !== undefined ? { tools } : {}),
        resourceLoader: prepared.resourceLoader,
        settingsManager: prepared.settingsManager,
        sessionManager: PiSessionManager.inMemory(cwd),
      });
      const names = session.getActiveToolNames();
      session.dispose();
      return names.sort();
    };

    expect(await activeTools(undefined)).toEqual([
      "bash",
      "edit",
      "read",
      "selected_tool",
      "write",
    ]);
    expect(await activeTools([])).toEqual([]);
    expect(await activeTools(["grep", "selected_tool"])).toEqual([
      "grep",
      "selected_tool",
    ]);
  });

  it("fails closed when an explicit extension cannot load", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-extension-error-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const selected = join(cwd, ".pi", "extensions", "selected");
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(selected, "index.js"), "export default 42;\n");

    await expect(
      createPiChildSessionFactory().prepareExtensions!({
        cwd,
        agentDir,
        systemPrompt: "Child prompt.",
        extensions: ["path:extensions/selected"],
      }),
    ).rejects.toThrow("Selected extension loading failed.");
  });

  it("fails when selected extensions register the same tool", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagents-extension-cross-conflict-"),
    );
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    writeExtension(join(cwd, ".pi", "extensions", "one"), "duplicate_tool");
    writeExtension(join(cwd, ".pi", "extensions", "two"), "duplicate_tool");

    await expect(
      createPiChildSessionFactory().prepareExtensions!({
        cwd,
        agentDir,
        systemPrompt: "Child prompt.",
        extensions: ["path:extensions/one", "path:extensions/two"],
      }),
    ).rejects.toThrow();
  });

  it("fails when an explicit extension collides with a built-in tool", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagents-extension-conflict-"),
    );
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    writeExtension(join(cwd, ".pi", "extensions", "selected"), "read");

    await expect(
      createPiChildSessionFactory().prepareExtensions!({
        cwd,
        agentDir,
        systemPrompt: "Child prompt.",
        extensions: ["path:extensions/selected"],
      }),
    ).rejects.toThrow("tool conflict");
  });
});
