/**
 * Layered-configuration tests (A2-A4): defaults, path precedence,
 * field-level merge, malformed input, ranges, unknown keys, model/thinking
 * validation, warning redaction, missing files, immutability, and
 * activation composition (S8-S16).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAME,
  type ConfigLoadOptions,
  DEFAULT_CONFIG,
  globalConfigPath,
  loadEffectiveConfig,
  projectConfigPath,
} from "../src/config.js";
import extension, { getEffectiveConfig } from "../src/index.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../src/types.js";

interface Fixture {
  agentDir: string;
  cwd: string;
  options: ConfigLoadOptions;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-minimal-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return {
    agentDir,
    cwd,
    options: { agentDir, cwd },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeGlobal(fixture: Fixture, body: string): void {
  writeFileSync(globalConfigPath(fixture.agentDir), body, "utf-8");
}

function writeProject(fixture: Fixture, body: string): void {
  writeFileSync(projectConfigPath(fixture.cwd), body, "utf-8");
}

async function boot(options: ConfigLoadOptions): Promise<void> {
  const pi = {
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  await extension(pi, undefined, options);
}

let warned: string[];
let fixtures: Fixture[];

beforeEach(() => {
  warned = [];
  fixtures = [];
});

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
});

function useFixture(): Fixture {
  const fixture = setupFixture();
  fixture.options = {
    ...fixture.options,
    onWarning: (message) => warned.push(message),
  };
  fixtures.push(fixture);
  return fixture;
}

describe("defaults (A2)", () => {
  it("resolves the specified global and project paths", () => {
    const fixture = useFixture();
    expect(globalConfigPath(fixture.agentDir)).toBe(
      join(fixture.agentDir, "extensions", CONFIG_FILE_NAME),
    );
    expect(projectConfigPath(fixture.cwd)).toBe(
      join(fixture.cwd, ".pi", CONFIG_FILE_NAME),
    );
    expect(CONFIG_FILE_NAME).toBe("pi-subagents-minimal.json");
  });

  it("returns 7 with absent model/thinking when no files exist", () => {
    const config = loadEffectiveConfig(useFixture().options);
    expect(config).toEqual({
      historyRetentionDays: 7,
      maxConcurrentSubagents: 8,
      injectGuidelines: true,
    });
    expect("defaultModel" in config).toBe(false);
    expect("defaultThinking" in config).toBe(false);
    expect(DEFAULT_CONFIG).toEqual({
      historyRetentionDays: 7,
      maxConcurrentSubagents: 8,
      injectGuidelines: true,
    });
  });

  it("is silent when both files are missing", () => {
    loadEffectiveConfig(useFixture().options);
    expect(warned).toEqual([]);
  });
});

describe("precedence and field-level merge (A3)", () => {
  it("applies valid global fields over defaults", () => {
    const fixture = useFixture();
    writeGlobal(
      fixture,
      JSON.stringify({
        historyRetentionDays: 14,
        defaultModel: "global-model",
        defaultThinking: "low",
      }),
    );
    expect(loadEffectiveConfig(fixture.options)).toEqual({
      historyRetentionDays: 14,
      defaultModel: "global-model",
      defaultThinking: "low",
      maxConcurrentSubagents: 8,
      injectGuidelines: true,
    });
    expect(warned).toEqual([]);
  });

  it("overrides global values by field, not by replacing the object", () => {
    const fixture = useFixture();
    writeGlobal(
      fixture,
      JSON.stringify({
        historyRetentionDays: 16,
        defaultModel: "global-model",
      }),
    );
    writeProject(fixture, JSON.stringify({ historyRetentionDays: 32 }));
    const config = loadEffectiveConfig(fixture.options);
    expect(config.historyRetentionDays).toBe(32);
    expect(config.defaultModel).toBe("global-model");
    expect(warned).toEqual([]);
  });

  it("keeps the lower-precedence value when the higher-precedence field is invalid", () => {
    const fixture = useFixture();
    writeGlobal(fixture, JSON.stringify({ historyRetentionDays: 16 }));
    writeProject(fixture, JSON.stringify({ historyRetentionDays: 0 }));
    const config = loadEffectiveConfig(fixture.options);
    expect(config.historyRetentionDays).toBe(16);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("historyRetentionDays");
  });

  it("still applies the project layer when the global file is malformed", () => {
    const fixture = useFixture();
    writeGlobal(fixture, "{not json");
    writeProject(fixture, JSON.stringify({ historyRetentionDays: 45 }));
    const config = loadEffectiveConfig(fixture.options);
    expect(config.historyRetentionDays).toBe(45);
    expect(warned).toHaveLength(1);
  });
});

describe("malformed input (A4)", () => {
  it("warns once and contributes nothing for invalid JSON", () => {
    const fixture = useFixture();
    writeGlobal(fixture, '{"historyRetentionDays": 16,');
    const config = loadEffectiveConfig(fixture.options);
    expect(config.historyRetentionDays).toBe(7);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(globalConfigPath(fixture.agentDir));
  });

  it.each([["null"], ["42"], ['"hello"'], ["true"], ["[]"]])(
    "warns once and contributes nothing for non-object root %s",
    (root) => {
      const fixture = useFixture();
      writeProject(fixture, root);
      const config = loadEffectiveConfig(fixture.options);
      expect(config).toEqual({
        historyRetentionDays: 7,
        maxConcurrentSubagents: 8,
        injectGuidelines: true,
      });
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(projectConfigPath(fixture.cwd));
    },
  );

  it("warns without aborting when the config path is unreadable", () => {
    const fixture = useFixture();
    mkdirSync(globalConfigPath(fixture.agentDir));
    const config = loadEffectiveConfig(fixture.options);
    expect(config.historyRetentionDays).toBe(7);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(globalConfigPath(fixture.agentDir));
  });

  it("warns per unknown field and ignores it while keeping valid fields", () => {
    const fixture = useFixture();
    writeGlobal(
      fixture,
      JSON.stringify({
        historyRetentionDays: 12,
        bogus: true,
        extra: { nested: 1 },
      }),
    );
    const config = loadEffectiveConfig(fixture.options);
    expect(config.historyRetentionDays).toBe(12);
    expect("bogus" in config).toBe(false);
    expect("extra" in config).toBe(false);
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("bogus");
    expect(warned[1]).toContain("extra");
  });
});

describe("numeric ranges (S14)", () => {
  const cases = [
    { field: "historyRetentionDays", min: 1, max: 3650 },
    { field: "maxConcurrentSubagents", min: 1, max: 64 },
  ] as const;

  it.each(cases)(
    "accepts the boundary values of $field",
    ({ field, min, max }) => {
      for (const value of [min, max]) {
        const fixture = useFixture();
        writeProject(fixture, JSON.stringify({ [field]: value }));
        expect(loadEffectiveConfig(fixture.options)[field]).toBe(value);
        expect(warned).toEqual([]);
      }
    },
  );

  it.each(cases)(
    "rejects out-of-range $field values",
    ({ field, min, max }) => {
      for (const value of [min - 1, max + 1]) {
        const fixture = useFixture();
        writeProject(fixture, JSON.stringify({ [field]: value }));
        expect(loadEffectiveConfig(fixture.options)[field]).toBe(
          DEFAULT_CONFIG[field],
        );
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain(field);
        warned.length = 0;
      }
    },
  );

  it.each(cases)(
    "rejects non-integer and non-number $field values",
    ({ field }) => {
      for (const value of [
        1.5,
        "8",
        null,
        true,
        {},
        [8],
        Number.MAX_SAFE_INTEGER + 2,
      ]) {
        const fixture = useFixture();
        writeProject(fixture, JSON.stringify({ [field]: value }));
        expect(loadEffectiveConfig(fixture.options)[field]).toBe(
          DEFAULT_CONFIG[field],
        );
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain(field);
        warned.length = 0;
      }
    },
  );
});

describe("defaultModel and defaultThinking (S15, S16)", () => {
  it("trims a valid defaultModel", () => {
    const fixture = useFixture();
    writeGlobal(fixture, JSON.stringify({ defaultModel: "  gpt-x  " }));
    expect(loadEffectiveConfig(fixture.options).defaultModel).toBe("gpt-x");
    expect(warned).toEqual([]);
  });

  it.each([[""], ["   "], [42], [null], [["x"]], [{}]])(
    "rejects invalid defaultModel %o",
    (value) => {
      const fixture = useFixture();
      writeProject(fixture, JSON.stringify({ defaultModel: value }));
      const config = loadEffectiveConfig(fixture.options);
      expect("defaultModel" in config).toBe(false);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("defaultModel");
    },
  );

  it("keeps the global defaultModel when the project value is invalid", () => {
    const fixture = useFixture();
    writeGlobal(fixture, JSON.stringify({ defaultModel: "global-model" }));
    writeProject(fixture, JSON.stringify({ defaultModel: "   " }));
    expect(loadEffectiveConfig(fixture.options).defaultModel).toBe(
      "global-model",
    );
    expect(warned).toHaveLength(1);
  });

  it.each(THINKING_LEVELS.map((level) => [level] as const))(
    "accepts thinking level %s",
    (level: ThinkingLevel) => {
      const fixture = useFixture();
      writeProject(fixture, JSON.stringify({ defaultThinking: level }));
      expect(loadEffectiveConfig(fixture.options).defaultThinking).toBe(level);
      expect(warned).toEqual([]);
    },
  );

  it.each([["ultra"], [""], ["OFF"], ["Medium"], [42], [null]])(
    "rejects invalid defaultThinking %o",
    (value) => {
      const fixture = useFixture();
      writeProject(fixture, JSON.stringify({ defaultThinking: value }));
      const config = loadEffectiveConfig(fixture.options);
      expect("defaultThinking" in config).toBe(false);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("defaultThinking");
    },
  );
});

describe("injectGuidelines", () => {
  it.each([[true], [false]])("accepts %o", (value) => {
    const fixture = useFixture();
    writeProject(fixture, JSON.stringify({ injectGuidelines: value }));
    expect(loadEffectiveConfig(fixture.options).injectGuidelines).toBe(value);
    expect(warned).toEqual([]);
  });

  it("project overrides global field-by-field", () => {
    const fixture = useFixture();
    writeGlobal(
      fixture,
      JSON.stringify({ historyRetentionDays: 16, injectGuidelines: false }),
    );
    writeProject(fixture, JSON.stringify({ injectGuidelines: true }));
    const config = loadEffectiveConfig(fixture.options);
    expect(config.injectGuidelines).toBe(true);
    expect(config.historyRetentionDays).toBe(16);
    expect(warned).toEqual([]);
  });

  it.each([["true"], [[42]], [[null]], [[{}]], [[[]]], [[1]]])(
    "rejects invalid injectGuidelines %o and falls back",
    (value) => {
      const fixture = useFixture();
      writeProject(fixture, JSON.stringify({ injectGuidelines: value }));
      const config = loadEffectiveConfig(fixture.options);
      expect(config.injectGuidelines).toBe(true);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("injectGuidelines");
    },
  );

  it("never exposes an invalid injectGuidelines value", () => {
    const fixture = useFixture();
    const secret = "sk-topsecret-guidelines-9f8e7d6c5b";
    writeProject(fixture, JSON.stringify({ injectGuidelines: secret }));
    const config = loadEffectiveConfig(fixture.options);
    expect(config.injectGuidelines).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned.join("\n")).not.toContain(secret);
  });

  it("keeps the global value when the project value is invalid", () => {
    const fixture = useFixture();
    writeGlobal(fixture, JSON.stringify({ injectGuidelines: false }));
    writeProject(fixture, JSON.stringify({ injectGuidelines: "yes" }));
    expect(loadEffectiveConfig(fixture.options).injectGuidelines).toBe(false);
    expect(warned).toHaveLength(1);
  });
});

describe("warning redaction", () => {
  it("never exposes file contents for malformed JSON", () => {
    const fixture = useFixture();
    const secret = "sk-topsecret-malformed-9f8e7d6c5b";
    writeGlobal(fixture, `{"historyRetentionDays": 16, ${secret}`);
    loadEffectiveConfig(fixture.options);
    expect(warned).toHaveLength(1);
    expect(warned.join("\n")).not.toContain(secret);
  });

  it("never exposes invalid values for rejected fields", () => {
    const fixture = useFixture();
    const secret = "sk-topsecret-field-1a2b3c4d5e";
    writeProject(
      fixture,
      JSON.stringify({ historyRetentionDays: secret, defaultThinking: secret }),
    );
    loadEffectiveConfig(fixture.options);
    expect(warned).toHaveLength(2);
    expect(warned.join("\n")).not.toContain(secret);
  });

  it("never exposes unknown-field values", () => {
    const fixture = useFixture();
    const secret = "sk-topsecret-unknown-6f5e4d3c2b";
    writeProject(fixture, JSON.stringify({ someUnknownField: secret }));
    loadEffectiveConfig(fixture.options);
    expect(warned).toHaveLength(1);
    // Naming the unknown key is the permitted field identification; the
    // value must never leak.
    expect(warned[0]).toContain("someUnknownField");
    expect(warned.join("\n")).not.toContain(secret);
  });
});

describe("immutability", () => {
  it("returns a frozen effective config and frozen defaults", () => {
    const config = loadEffectiveConfig(useFixture().options);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(() => {
      (config as { historyRetentionDays: number }).historyRetentionDays = 1;
    }).toThrow();
  });
});

describe("activation composition (S8)", () => {
  it("loads once during activation and exposes one immutable config", async () => {
    const fixture = useFixture();
    writeGlobal(fixture, JSON.stringify({ historyRetentionDays: 20 }));
    writeProject(fixture, JSON.stringify({ defaultModel: "project-model" }));
    await boot(fixture.options);
    const config = getEffectiveConfig();
    expect(config).toEqual({
      historyRetentionDays: 20,
      defaultModel: "project-model",
      maxConcurrentSubagents: 8,
      injectGuidelines: true,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(getEffectiveConfig()).toBe(config);
    expect(warned).toEqual([]);
  });

  it("reloads on the next activation", async () => {
    const fixture = useFixture();
    await boot(fixture.options);
    expect(getEffectiveConfig().historyRetentionDays).toBe(7);
    writeProject(fixture, JSON.stringify({ historyRetentionDays: 48 }));
    await boot(fixture.options);
    expect(getEffectiveConfig().historyRetentionDays).toBe(48);
  });
});
