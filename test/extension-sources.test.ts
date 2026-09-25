import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeExtensionSource,
  resolveExtensionSources,
} from "../src/agents/extensions.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-extensions-"));
  roots.push(root);
  return { root, cwd: join(root, "project"), agentDir: join(root, "agent") };
}

function installNpmExtension(installRoot: string, packageName: string): string {
  const packageRoot = join(installRoot, packageName);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      pi: { extensions: ["./index.js"] },
    }),
  );
  const entrypoint = join(packageRoot, "index.js");
  writeFileSync(entrypoint, "export default () => {};\n");
  return entrypoint;
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extension source normalization", () => {
  it("accepts unversioned npm package names and safe relative path sources", () => {
    expect(normalizeExtensionSource(" npm:pi-web-access ")).toBe(
      "npm:pi-web-access",
    );
    expect(normalizeExtensionSource("npm:@scope/pi-web-access")).toBe(
      "npm:@scope/pi-web-access",
    );
    expect(normalizeExtensionSource(" path:extensions/pi-web-access ")).toBe(
      "path:extensions/pi-web-access",
    );
  });

  it.each([
    "",
    "git:example/repo",
    "npm:",
    "npm:@scope",
    "npm:bad package",
    "npm:pi-web-access@1.0.0",
    "npm:pi-web-access@next",
    "npm:@scope/pi-web-access@^1.0.0",
    "path:",
    "path:/absolute",
    "path:C:\\absolute",
    "path:../outside",
    "path:extensions/../outside",
    "path:extensions//nested",
  ])("rejects malformed or unsafe source %j", (source) => {
    expect(normalizeExtensionSource(source)).toBeUndefined();
  });
});

describe("local extension resolution", () => {
  it("rejects versioned npm sources again at runtime resolution", async () => {
    const { cwd, agentDir } = fixture();

    await expect(
      resolveExtensionSources(["npm:pi-web-access@1.0.0"], cwd, agentDir),
    ).rejects.toThrow("Invalid extension source.");
  });

  it("uses the project candidate before the agent-directory candidate", async () => {
    const { cwd, agentDir } = fixture();
    const project = join(cwd, ".pi", "extensions", "pi-web-access");
    const global = join(agentDir, "extensions", "pi-web-access");
    mkdirSync(project, { recursive: true });
    mkdirSync(global, { recursive: true });
    writeFileSync(join(project, "index.js"), "export default () => {};\n");
    writeFileSync(join(global, "index.js"), "export default () => {};\n");

    await expect(
      resolveExtensionSources(["path:extensions/pi-web-access"], cwd, agentDir),
    ).resolves.toEqual([realpathSync(join(project, "index.js"))]);
  });

  it("falls back to the agent-directory candidate when the project candidate is missing", async () => {
    const { cwd, agentDir } = fixture();
    const global = join(agentDir, "extensions", "pi-web-access");
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, "index.js"), "export default () => {};\n");

    await expect(
      resolveExtensionSources(["path:extensions/pi-web-access"], cwd, agentDir),
    ).resolves.toEqual([realpathSync(join(global, "index.js"))]);
  });

  it("preserves direct local extension file support", async () => {
    const { cwd, agentDir } = fixture();
    const direct = join(cwd, ".pi", "extensions", "direct.ts");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(direct, "export default () => {};\n");

    await expect(
      resolveExtensionSources(["path:extensions/direct.ts"], cwd, agentDir),
    ).resolves.toEqual([realpathSync(direct)]);
  });

  it("uses the Pi-managed project npm package before the user package", async () => {
    const { cwd, agentDir } = fixture();
    const projectEntry = installNpmExtension(
      join(cwd, ".pi", "npm", "node_modules"),
      "pi-web-access",
    );
    installNpmExtension(join(agentDir, "npm", "node_modules"), "pi-web-access");

    await expect(
      resolveExtensionSources(["npm:pi-web-access"], cwd, agentDir),
    ).resolves.toEqual([realpathSync(projectEntry)]);
  });

  it("falls back to the Pi-managed user npm package", async () => {
    const { cwd, agentDir } = fixture();
    const userEntry = installNpmExtension(
      join(agentDir, "npm", "node_modules"),
      "pi-web-access",
    );

    await expect(
      resolveExtensionSources(["npm:pi-web-access"], cwd, agentDir),
    ).resolves.toEqual([realpathSync(userEntry)]);
  });

  it("supports installed scoped npm packages", async () => {
    const { cwd, agentDir } = fixture();
    const projectEntry = installNpmExtension(
      join(cwd, ".pi", "npm", "node_modules"),
      "@scope/pi-web-access",
    );

    await expect(
      resolveExtensionSources(["npm:@scope/pi-web-access"], cwd, agentDir),
    ).resolves.toEqual([realpathSync(projectEntry)]);
  });

  it("fails instead of using ordinary node_modules or temporarily resolving a missing npm package", async () => {
    const { cwd, agentDir } = fixture();
    installNpmExtension(join(cwd, "node_modules"), "pi-web-access");

    await expect(
      resolveExtensionSources(["npm:pi-web-access"], cwd, agentDir),
    ).rejects.toThrow("Extension package is not installed.");
    expect(existsSync(join(agentDir, "tmp", "extensions"))).toBe(false);
  });

  it("fails closed for missing targets", async () => {
    const { cwd, agentDir } = fixture();
    await expect(
      resolveExtensionSources(["path:extensions/missing"], cwd, agentDir),
    ).rejects.toThrow("Extension path does not exist.");
  });

  it("expands manifest globs and exclusions with Pi ordering and deduplication", async () => {
    const { cwd, agentDir } = fixture();
    const selected = join(cwd, ".pi", "packages", "selected");
    mkdirSync(join(selected, "extensions", "nested"), { recursive: true });
    writeFileSync(
      join(selected, "package.json"),
      JSON.stringify({
        pi: {
          extensions: [
            "extensions/**/*.ts",
            "extensions/nested/*.ts",
            "!extensions/**/*.test.ts",
          ],
        },
      }),
    );
    writeFileSync(
      join(selected, "extensions", "one.ts"),
      "export default () => {};\n",
    );
    writeFileSync(
      join(selected, "extensions", "one.test.ts"),
      "export default () => {};\n",
    );
    writeFileSync(
      join(selected, "extensions", "nested", "two.ts"),
      "export default () => {};\n",
    );

    await expect(
      resolveExtensionSources(["path:packages/selected"], cwd, agentDir),
    ).resolves.toEqual([
      realpathSync(join(selected, "extensions", "one.ts")),
      realpathSync(join(selected, "extensions", "nested", "two.ts")),
    ]);
  });

  it("uses only Pi package conventions when no manifest is declared", async () => {
    const { cwd, agentDir } = fixture();
    const selected = join(cwd, ".pi", "packages", "selected");
    mkdirSync(join(selected, "extensions"), { recursive: true });
    writeFileSync(
      join(selected, "unrelated.js"),
      "throw new Error('must not load');\n",
    );
    writeFileSync(
      join(selected, "src.ts"),
      "throw new Error('must not load');\n",
    );
    writeFileSync(
      join(selected, "extensions", "selected.ts"),
      "export default () => {};\n",
    );

    await expect(
      resolveExtensionSources(["path:packages/selected"], cwd, agentDir),
    ).resolves.toEqual([
      realpathSync(join(selected, "extensions", "selected.ts")),
    ]);
  });

  it("matches Pi convention-directory ignore files and one-level discovery", async () => {
    const { cwd, agentDir } = fixture();
    const selected = join(cwd, ".pi", "packages", "selected");
    const extensions = join(selected, "extensions");
    mkdirSync(join(extensions, "nested", "deeper"), { recursive: true });
    mkdirSync(join(extensions, "child"), { recursive: true });
    writeFileSync(join(extensions, ".gitignore"), "ignored.ts\nnested/\n");
    writeFileSync(join(extensions, "kept.ts"), "export default () => {};\n");
    writeFileSync(join(extensions, "ignored.ts"), "export default () => {};\n");
    writeFileSync(
      join(extensions, "nested", "index.ts"),
      "export default () => {};\n",
    );
    writeFileSync(
      join(extensions, "child", "index.js"),
      "export default () => {};\n",
    );
    writeFileSync(
      join(extensions, "child", "other.js"),
      "throw new Error('one-level child scripts must not load');\n",
    );

    await expect(
      resolveExtensionSources(["path:packages/selected"], cwd, agentDir),
    ).resolves.toEqual([
      realpathSync(join(extensions, "child", "index.js")),
      realpathSync(join(extensions, "kept.ts")),
    ]);
  });

  it.each([
    { pi: { extensions: "index.js" } },
    { pi: { extensions: [""] } },
    { pi: { extensions: ["../outside.js"] } },
    { pi: { extensions: ["../outside/*.js"] } },
    { pi: { extensions: ["/tmp/outside.js"] } },
    { pi: { extensions: ["extensions/../outside.js"] } },
    { pi: { extensions: ["missing.js"] } },
  ])("rejects invalid manifest declarations %#", async (manifest) => {
    const { cwd, agentDir } = fixture();
    const selected = join(cwd, ".pi", "extensions", "selected");
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(selected, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(selected, "index.js"), "export default () => {};\n");

    await expect(
      resolveExtensionSources(["path:extensions/selected"], cwd, agentDir),
    ).rejects.toThrow();
  });

  it("rejects malformed manifests and unsupported file targets without fallback", async () => {
    const { cwd, agentDir } = fixture();
    const malformed = join(cwd, ".pi", "extensions", "malformed");
    const fallback = join(agentDir, "extensions", "malformed");
    mkdirSync(malformed, { recursive: true });
    mkdirSync(fallback, { recursive: true });
    writeFileSync(join(malformed, "package.json"), "{not-json");
    writeFileSync(join(malformed, "index.js"), "export default () => {};\n");
    writeFileSync(join(fallback, "index.js"), "export default () => {};\n");
    await expect(
      resolveExtensionSources(["path:extensions/malformed"], cwd, agentDir),
    ).rejects.toThrow("Invalid extension manifest.");

    const unsupported = join(cwd, ".pi", "extensions", "unsupported.json");
    writeFileSync(unsupported, "{}\n");
    await expect(
      resolveExtensionSources(
        ["path:extensions/unsupported.json"],
        cwd,
        agentDir,
      ),
    ).rejects.toThrow("Unsupported extension target.");
  });

  it("rejects traversal produced by structured glob expansion", async () => {
    const { cwd, agentDir } = fixture();
    const packages = join(cwd, ".pi", "packages");
    const selected = join(packages, "selected");
    const outside = join(packages, "outside");
    mkdirSync(join(selected, "extensions"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(selected, "package.json"),
      JSON.stringify({ pi: { extensions: ["{extensions,../outside}/*.js"] } }),
    );
    writeFileSync(
      join(selected, "extensions", "safe.js"),
      "export default () => {};\n",
    );
    writeFileSync(join(outside, "escaped.js"), "export default () => {};\n");

    await expect(
      resolveExtensionSources(["path:packages/selected"], cwd, agentDir),
    ).rejects.toThrow("Invalid extension path.");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a project symlink escape instead of falling back to a valid global target",
    async () => {
      const { root, cwd, agentDir } = fixture();
      const outside = join(root, "outside");
      const projectParent = join(cwd, ".pi", "extensions");
      const global = join(agentDir, "extensions", "pi-web-access");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "index.js"), "export default () => {};\n");
      mkdirSync(projectParent, { recursive: true });
      symlinkSync(outside, join(projectParent, "pi-web-access"));
      mkdirSync(global, { recursive: true });
      writeFileSync(join(global, "index.js"), "export default () => {};\n");

      await expect(
        resolveExtensionSources(
          ["path:extensions/pi-web-access"],
          cwd,
          agentDir,
        ),
      ).rejects.toThrow("Invalid extension path.");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a project npm package symlink escape instead of using the user package",
    async () => {
      const { root, cwd, agentDir } = fixture();
      const outside = join(root, "outside-package");
      const projectNodeModules = join(cwd, ".pi", "npm", "node_modules");
      installNpmExtension(root, "outside-package");
      mkdirSync(projectNodeModules, { recursive: true });
      symlinkSync(outside, join(projectNodeModules, "pi-web-access"));
      installNpmExtension(
        join(agentDir, "npm", "node_modules"),
        "pi-web-access",
      );

      await expect(
        resolveExtensionSources(["npm:pi-web-access"], cwd, agentDir),
      ).rejects.toThrow("Invalid extension path.");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a glob-matched symlink escape",
    async () => {
      const { root, cwd, agentDir } = fixture();
      const selected = join(cwd, ".pi", "packages", "selected");
      const outside = join(root, "outside.js");
      mkdirSync(join(selected, "extensions"), { recursive: true });
      writeFileSync(
        join(selected, "package.json"),
        JSON.stringify({ pi: { extensions: ["extensions/*.js"] } }),
      );
      writeFileSync(outside, "export default () => {};\n");
      symlinkSync(outside, join(selected, "extensions", "escaped.js"));

      await expect(
        resolveExtensionSources(["path:packages/selected"], cwd, agentDir),
      ).rejects.toThrow("Invalid extension path.");
    },
  );
});
