/**
 * Discovery and precedence tests (T2): exact paths, empty registries,
 * `.md`-only filtering, lexical ordering, three-layer precedence, case
 * sensitivity, same-directory duplicates, disabled overrides, invalid-file
 * isolation, directory/file read failures, warning redaction and order, and
 * reload visibility (S1-S4, A1, A4-A5).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  globalAgentsDir,
  loadAgentLayer,
  piProjectAgentsDir,
  sharedProjectAgentsDir,
} from "../src/agents/loader.js";
import {
  createAgentRegistry,
  findAgentForSession,
  getSelectableDefinitions,
  loadAgentRegistry,
} from "../src/agents/registry.js";

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
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-minimal-registry-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const globalDir = join(agentDir, "agents");
  const sharedDir = join(cwd, ".agents", "agents");
  const piDir = join(cwd, ".pi", "agents");
  const fixture = { root, agentDir, cwd, globalDir, sharedDir, piDir };
  fixtures.push(fixture);
  return fixture;
}

function optionsOf(fixture: Fixture): { agentDir: string; cwd: string } {
  return { agentDir: fixture.agentDir, cwd: fixture.cwd };
}

/** Build a minimal valid agent document. */
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

afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop()!.root, { recursive: true, force: true });
  }
});

describe("paths and empty registries", () => {
  it("resolves the three exact agent directories", () => {
    const fixture = useFixture();
    expect(globalAgentsDir(fixture.agentDir)).toBe(
      join(fixture.agentDir, "agents"),
    );
    expect(sharedProjectAgentsDir(fixture.cwd)).toBe(
      join(fixture.cwd, ".agents", "agents"),
    );
    expect(piProjectAgentsDir(fixture.cwd)).toBe(
      join(fixture.cwd, ".pi", "agents"),
    );
  });

  it("returns an empty registry when all directories are missing", () => {
    const snapshot = loadAgentRegistry(optionsOf(useFixture()));
    expect(snapshot).toEqual({ definitions: [], warnings: [] });
  });

  it("returns an empty registry when directories exist but hold no .md files", () => {
    const fixture = useFixture();
    mkdirSync(fixture.globalDir, { recursive: true });
    mkdirSync(fixture.sharedDir, { recursive: true });
    mkdirSync(fixture.piDir, { recursive: true });
    expect(loadAgentRegistry(optionsOf(fixture))).toEqual({
      definitions: [],
      warnings: [],
    });
  });

  it("treats a missing layer as silent while other layers load", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "solo.md", doc("solo"));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions.map((d) => d.name)).toEqual(["solo"]);
    expect(snapshot.warnings).toEqual([]);
  });
});

describe("file filtering and sources", () => {
  it("discovers only direct *.md files", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "kept.md", doc("kept"));
    writeAgent(fixture.globalDir, "notes.txt", doc("notes"));
    writeAgent(fixture.globalDir, "agent.markdown", doc("agent"));
    writeAgent(fixture.globalDir, "UPPER.MD", doc("upper"));
    writeAgent(fixture.globalDir, "backup.md.bak", doc("backup"));
    mkdirSync(join(fixture.globalDir, "nested"), { recursive: true });
    writeFileSync(
      join(fixture.globalDir, "nested", "deep.md"),
      doc("deep"),
      "utf-8",
    );

    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions.map((d) => d.name)).toEqual(["kept"]);
    expect(snapshot.warnings).toEqual([]);
  });

  it("normalizes global to global and both project layers to project", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "g.md", doc("g"));
    writeAgent(fixture.sharedDir, "s.md", doc("s"));
    writeAgent(fixture.piDir, "p.md", doc("p"));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(
      snapshot.definitions.map((d) => `${d.name}:${d.source}`).sort(),
    ).toEqual(["g:global", "p:project", "s:project"]);
  });
});

describe("precedence", () => {
  it("resolves global < shared < pi for the same name", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("dup", "Global."));
    writeAgent(fixture.sharedDir, "a.md", doc("dup", "Shared."));
    writeAgent(fixture.piDir, "a.md", doc("dup", "Pi."));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions).toHaveLength(1);
    expect(snapshot.definitions[0]?.description).toBe("Pi.");
    expect(snapshot.definitions[0]?.source).toBe("project");
    expect(snapshot.warnings).toEqual([]);
  });

  it("lets the shared layer override global when pi is absent", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("dup", "Global."));
    writeAgent(fixture.sharedDir, "a.md", doc("dup", "Shared."));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions[0]?.description).toBe("Shared.");
    expect(snapshot.warnings).toEqual([]);
  });

  it("keeps names case-sensitively distinct across layers", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "lower.md", doc("helper", "Global lower."));
    writeAgent(fixture.piDir, "upper.md", doc("Helper", "Pi upper."));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions.map((d) => d.name).sort()).toEqual([
      "Helper",
      "helper",
    ]);
  });
});

describe("same-directory duplicates", () => {
  it("resolves to the lexically later file with one replacement warning", () => {
    const fixture = useFixture();
    // Create in reverse order to prove processing is lexical, not creation order.
    writeAgent(
      fixture.globalDir,
      "b-second.md",
      doc("worker", "Second description."),
    );
    writeAgent(
      fixture.globalDir,
      "a-first.md",
      doc("worker", "First description."),
    );
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions).toHaveLength(1);
    expect(snapshot.definitions[0]?.description).toBe("Second description.");
    expect(snapshot.definitions[0]?.sourcePath).toBe(
      join(fixture.globalDir, "b-second.md"),
    );
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]?.path).toBe(
      join(fixture.globalDir, "b-second.md"),
    );
    expect(snapshot.warnings[0]?.message).toBe(
      "duplicate agent name: replacing earlier definition from this directory",
    );
    const serializedWarnings = JSON.stringify(snapshot.warnings);
    expect(serializedWarnings).not.toContain("worker");
    expect(serializedWarnings).not.toContain("First description.");
    expect(serializedWarnings).not.toContain("Second description.");
    expect(serializedWarnings).not.toContain("Do the thing.");
  });

  it("never leaks replaced body contents in duplicate warnings", () => {
    const fixture = useFixture();
    const secret = "body-secret-token-dup-abc123";
    writeAgent(
      fixture.globalDir,
      "a.md",
      `---\nname: dup\ndescription: First.\n---\n${secret}\n`,
    );
    writeAgent(fixture.globalDir, "b.md", doc("dup", "Second."));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.warnings).toHaveLength(1);
    expect(JSON.stringify(snapshot.warnings)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });
});

describe("disabled overrides", () => {
  it("keeps a valid disabled higher definition authoritative but unselectable", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("dup", "Global."));
    writeAgent(
      fixture.piDir,
      "off.md",
      `---\nname: dup\ndescription: Disabled.\nenabled: false\n---\n# dup\nOff.\n`,
    );
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions).toHaveLength(1);
    expect(snapshot.definitions[0]?.enabled).toBe(false);
    expect(snapshot.definitions[0]?.description).toBe("Disabled.");
    expect(getSelectableDefinitions(snapshot)).toEqual([]);
    expect(findAgentForSession(snapshot, "dup")).toBeUndefined();
    const candidates = createAgentRegistry(optionsOf(fixture)).listCandidates();
    expect(candidates.definitions).toEqual([]);
  });

  it("lets a valid enabled higher definition re-enable a disabled lower one", () => {
    const fixture = useFixture();
    writeAgent(
      fixture.globalDir,
      "a.md",
      `---\nname: dup\ndescription: Off.\nenabled: false\n---\n# dup\nOff.\n`,
    );
    writeAgent(fixture.piDir, "on.md", doc("dup", "On."));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions[0]?.enabled).toBe(true);
    expect(getSelectableDefinitions(snapshot).map((d) => d.name)).toEqual([
      "dup",
    ]);
    expect(findAgentForSession(snapshot, "dup")?.description).toBe("On.");
  });
});

describe("invalid files", () => {
  it("isolates one invalid file and keeps the valid one", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "good.md", doc("good"));
    writeAgent(fixture.globalDir, "bad.md", "---\nname: bad\n---\n");
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions.map((d) => d.name)).toEqual(["good"]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]?.path).toBe(join(fixture.globalDir, "bad.md"));
  });

  it("preserves a valid lower definition when the higher file is invalid", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("dup", "Global."));
    writeAgent(
      fixture.piDir,
      "a.md",
      "---\nname: dup\ndescription: Broken.\nmax_turns: 0\n---\n# dup\nBody.\n",
    );
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions).toHaveLength(1);
    expect(snapshot.definitions[0]?.description).toBe("Global.");
    expect(snapshot.definitions[0]?.source).toBe("global");
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]?.path).toBe(join(fixture.piDir, "a.md"));
  });
});

describe("filesystem failures", () => {
  it("warns on an unreadable directory without blocking other layers", () => {
    const fixture = useFixture();
    mkdirSync(fixture.globalDir, { recursive: true });
    // Occupy the shared directory path with a file so readdir fails (ENOTDIR).
    mkdirSync(join(fixture.cwd, ".agents"), { recursive: true });
    writeFileSync(fixture.sharedDir, "not a directory", "utf-8");
    writeAgent(fixture.piDir, "p.md", doc("p"));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions.map((d) => d.name)).toEqual(["p"]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]?.path).toBe(fixture.sharedDir);
    expect(snapshot.warnings[0]?.message).toContain("unreadable directory");
  });

  it("warns on an unreadable file without blocking sibling files", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "good.md", doc("good"));
    mkdirSync(join(fixture.globalDir, "blocked.md"));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions.map((d) => d.name)).toEqual(["good"]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]?.path).toBe(
      join(fixture.globalDir, "blocked.md"),
    );
    expect(snapshot.warnings[0]?.message).toContain("unreadable file");
  });

  it("loads a single layer directly with lexical file processing", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "b.md", "---\nname: x\n---\n");
    writeAgent(fixture.globalDir, "a.md", doc("ok"));
    const scan = loadAgentLayer(fixture.globalDir, "global");
    expect(scan.definitions.map((d) => d.name)).toEqual(["ok"]);
    expect(scan.warnings.map((w) => w.path)).toEqual([
      join(fixture.globalDir, "b.md"),
    ]);
  });
});

describe("warning order and redaction", () => {
  it("orders warnings global, shared, pi with lexical order inside a layer", () => {
    const fixture = useFixture();
    writeAgent(fixture.piDir, "bad.md", "---\nname: p\n---\n");
    writeAgent(fixture.globalDir, "b-bad.md", "---\nname: g2\n---\n");
    writeAgent(fixture.globalDir, "a-bad.md", "---\nname: g1\n---\n");
    writeAgent(fixture.sharedDir, "bad.md", "---\nname: s\n---\n");
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions).toEqual([]);
    expect(snapshot.warnings.map((w) => w.path)).toEqual([
      join(fixture.globalDir, "a-bad.md"),
      join(fixture.globalDir, "b-bad.md"),
      join(fixture.sharedDir, "bad.md"),
      join(fixture.piDir, "bad.md"),
    ]);
  });

  it("never exposes file contents or invalid values in warnings", () => {
    const fixture = useFixture();
    const nameSecret = "sekret-invalid-name!!!";
    const modelSecret = "sk-secret-hunter2-model";
    const bodySecret = "body-secret-token-xyz789";
    writeAgent(
      fixture.globalDir,
      "bad.md",
      `---\nname: '${nameSecret}'\ndescription: d\nmodel: '${modelSecret}'\n---\n${bodySecret}\n`,
    );
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions).toEqual([]);
    expect(snapshot.warnings).toHaveLength(1);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(nameSecret);
    expect(serialized).not.toContain(modelSecret);
    expect(serialized).not.toContain(bodySecret);
    expect(snapshot.warnings[0]?.path).toBe(join(fixture.globalDir, "bad.md"));
  });
});

describe("explicit discovery and activation snapshots", () => {
  it("reflects file edits, additions, and removals on reload", () => {
    const fixture = useFixture();
    const options = optionsOf(fixture);
    const file = writeAgent(fixture.globalDir, "a.md", doc("alpha", "First."));
    expect(loadAgentRegistry(options).definitions[0]?.description).toBe(
      "First.",
    );

    writeFileSync(file, doc("alpha", "Second."), "utf-8");
    expect(loadAgentRegistry(options).definitions[0]?.description).toBe(
      "Second.",
    );

    writeAgent(fixture.piDir, "b.md", doc("beta"));
    expect(loadAgentRegistry(options).definitions.map((d) => d.name)).toEqual([
      "alpha",
      "beta",
    ]);

    rmSync(file, { force: true });
    expect(loadAgentRegistry(options).definitions.map((d) => d.name)).toEqual([
      "beta",
    ]);
  });

  it("keeps one bound snapshot stable until a new registry is constructed", () => {
    const fixture = useFixture();
    const options = optionsOf(fixture);
    const emptyActivation = createAgentRegistry(options);
    expect(emptyActivation.snapshot().definitions).toEqual([]);

    const file = writeAgent(fixture.globalDir, "a.md", doc("fresh"));
    expect(emptyActivation.snapshot().definitions).toEqual([]);
    expect(emptyActivation.listCandidates().definitions).toEqual([]);
    expect(emptyActivation.findForSession("fresh")).toBeUndefined();
    expect(emptyActivation.findCurrent("fresh")).toBeUndefined();

    const enabledActivation = createAgentRegistry(options);
    expect(enabledActivation.snapshot().definitions.map((d) => d.name)).toEqual(
      ["fresh"],
    );
    expect(
      enabledActivation.listCandidates().definitions.map((d) => d.name),
    ).toEqual(["fresh"]);
    expect(enabledActivation.findForSession("fresh")?.name).toBe("fresh");
    expect(enabledActivation.findCurrent("fresh")?.description).toBe(
      "fresh does things.",
    );

    writeFileSync(
      file,
      `---\nname: fresh\ndescription: Now off.\nenabled: false\n---\n# fresh\nOff.\n`,
      "utf-8",
    );
    expect(enabledActivation.findForSession("fresh")?.enabled).toBe(true);
    expect(enabledActivation.findCurrent("fresh")?.description).toBe(
      "fresh does things.",
    );

    const disabledActivation = createAgentRegistry(options);
    expect(disabledActivation.listCandidates().definitions).toEqual([]);
    expect(disabledActivation.findForSession("fresh")).toBeUndefined();
    expect(disabledActivation.findCurrent("fresh")).toMatchObject({
      name: "fresh",
      enabled: false,
      description: "Now off.",
    });

    rmSync(file, { force: true });
    expect(disabledActivation.findCurrent("fresh")?.description).toBe(
      "Now off.",
    );
    expect(createAgentRegistry(options).findCurrent("fresh")).toBeUndefined();
  });

  it("returns defensive copies of the captured definitions and warnings", () => {
    const fixture = useFixture();
    writeAgent(
      fixture.globalDir,
      "a.md",
      doc(
        "stable",
        "Original.",
        "\ntools: [read]\nskills: [review]\ndisallowed_tools: [bash]\ndisallowed_skills: [deploy]",
      ),
    );
    writeAgent(fixture.globalDir, "bad.md", "---\nname: bad\n---\n");
    const registry = createAgentRegistry(optionsOf(fixture));

    const first = registry.snapshot();
    first.definitions[0]!.description = "Mutated.";
    (first.definitions[0]!.tools as string[]).push("bash");
    (first.definitions[0]!.skills as string[]).push("deploy");
    first.definitions[0]!.disallowedTools.push("write");
    first.definitions[0]!.disallowedSkills.push("review");
    first.warnings[0]!.message = "Mutated warning.";

    expect(registry.findCurrent("stable")).toMatchObject({
      description: "Original.",
      tools: ["read"],
      skills: ["review"],
      disallowedTools: ["bash"],
      disallowedSkills: ["deploy"],
    });
    expect(registry.snapshot().warnings[0]?.message).not.toBe(
      "Mutated warning.",
    );
  });

  it("returns list candidates sorted by name with warnings", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "z.md", doc("zulu"));
    writeAgent(fixture.globalDir, "a.md", doc("alpha"));
    writeAgent(
      fixture.globalDir,
      "m.md",
      `---\nname: mike\ndescription: Off.\nenabled: false\n---\n# mike\nOff.\n`,
    );
    writeAgent(fixture.globalDir, "bad.md", "---\nname: bad\n---\n");
    const registry = createAgentRegistry(optionsOf(fixture));
    const candidates = registry.listCandidates();
    expect(candidates.definitions.map((d) => d.name)).toEqual([
      "alpha",
      "zulu",
    ]);
    expect(candidates.warnings.map((w) => w.path)).toEqual([
      join(fixture.globalDir, "bad.md"),
    ]);
  });

  it("looks up exact case-sensitive names among enabled definitions only", () => {
    const fixture = useFixture();
    writeAgent(fixture.globalDir, "a.md", doc("helper"));
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(findAgentForSession(snapshot, "helper")?.name).toBe("helper");
    expect(findAgentForSession(snapshot, "Helper")).toBeUndefined();
    expect(findAgentForSession(snapshot, "missing")).toBeUndefined();
    expect(findAgentForSession(snapshot, "")).toBeUndefined();
  });

  it("exposes only normalized definitions without raw frontmatter", () => {
    const fixture = useFixture();
    writeAgent(
      fixture.globalDir,
      "full.md",
      "---\nname: full\ndescription: All fields.\nmodel: opus\nthinking: high\ntools: [read]\nmax_turns: 10\nmemory: should-not-escape\n---\n# full\nBody.\n",
    );
    const snapshot = loadAgentRegistry(optionsOf(fixture));
    expect(snapshot.definitions).toHaveLength(1);
    const definition = snapshot.definitions[0]!;
    expect(definition).toMatchObject({
      name: "full",
      model: "opus",
      thinking: "high",
      tools: ["read"],
      maxTurns: 10,
      source: "global",
    });
    expect("memory" in definition).toBe(false);
    expect(Object.keys(definition).sort()).toEqual(
      [
        "description",
        "disallowedSkills",
        "disallowedTools",
        "enabled",
        "maxTurns",
        "model",
        "name",
        "skills",
        "source",
        "sourcePath",
        "systemPrompt",
        "thinking",
        "tools",
      ].sort(),
    );
    // Raw file text is never retained alongside the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("should-not-escape");
    expect(readFileSync(join(fixture.globalDir, "full.md"), "utf-8")).toContain(
      "should-not-escape",
    );
  });
});
