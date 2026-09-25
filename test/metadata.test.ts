/**
 * Metadata unit tests (A2, A3): strict known-field validation (S5-S13),
 * normalization into `AgentDefinition` (S15-S16), silent unknown-key
 * handling, whole-file rejection with one redacted path-specific warning
 * (S14, N2), and BOM/line-ending tolerance.
 */

import { describe, expect, it } from "vitest";
import {
  type AgentFileRef,
  parseAgentMetadata,
} from "../src/agents/metadata.js";
import type { AgentDefinition } from "../src/types.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../src/types.js";

const REF: AgentFileRef = {
  source: "project",
  sourcePath: "/proj/.pi/agents/helper.md",
};

/** Build a `---` frontmatter document with the given YAML and body. */
function doc(frontmatter: string, body = "# Helper\nDo the thing.\n"): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

function parse(frontmatter: string, body?: string) {
  return parseAgentMetadata(doc(frontmatter, body), REF);
}

describe("valid metadata normalization (A2)", () => {
  it("normalizes a minimal file with defaults", () => {
    const result = parse("name: helper\ndescription: Does the thing.");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toEqual({
      name: "helper",
      description: "Does the thing.",
      tools: [],
      disallowedTools: [],
      skills: [],
      disallowedSkills: [],
      enabled: true,
      systemPrompt: "# Helper\nDo the thing.",
      source: "project",
      sourcePath: REF.sourcePath,
    });
    expect("warning" in result).toBe(false);
  });

  it("exposes exactly the S15 contract keys and no raw frontmatter", () => {
    const result = parseAgentMetadata(
      doc(
        "name: full\ndescription: All fields.\nmodel: opus\nthinking: high\ntools: [read]\nextensions: [npm:pi-web-access, path:extensions/local]\nmax_turns: 10\nenabled: false\nmemory: should-not-escape",
      ),
      { source: "global", sourcePath: "/g/agents/full.md" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.definition).sort()).toEqual(
      [
        "description",
        "disallowedSkills",
        "disallowedTools",
        "enabled",
        "extensions",
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
    expect(result.definition).toMatchObject({
      name: "full",
      model: "opus",
      thinking: "high",
      tools: ["read"],
      extensions: ["npm:pi-web-access", "path:extensions/local"],
      maxTurns: 10,
      enabled: false,
      source: "global",
      sourcePath: "/g/agents/full.md",
    });
  });

  it("accepts 1-character and 64-character names", () => {
    for (const name of ["a", "A0-_".padEnd(64, "x")]) {
      expect(name).toHaveLength(name === "a" ? 1 : 64);
      const result = parse(`name: ${name}\ndescription: d`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.definition.name).toBe(name);
    }
  });

  it("trims the description and enforces 512 characters after trimming", () => {
    const padded = parse("name: a\ndescription: '  padded  '");
    expect(padded.ok).toBe(true);
    if (padded.ok) expect(padded.definition.description).toBe("padded");

    const max = parse(`name: a\ndescription: '${"d".repeat(512)}'`);
    expect(max.ok).toBe(true);
    if (max.ok) expect(max.definition.description).toHaveLength(512);
  });

  it("trims the model", () => {
    const result = parse("name: a\ndescription: d\nmodel: '  opus  '");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.model).toBe("opus");
  });

  it("accepts every thinking level (S9)", () => {
    for (const thinking of THINKING_LEVELS) {
      const result = parse(`name: a\ndescription: d\nthinking: ${thinking}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const level: ThinkingLevel = thinking;
        expect(result.definition.thinking).toBe(level);
      }
    }
  });

  it("normalizes omitted and explicit empty tools to [] (S10)", () => {
    const omitted = parse("name: a\ndescription: d");
    expect(omitted.ok && omitted.definition.tools).toEqual([]);

    const empty = parse("name: a\ndescription: d\ntools: []");
    expect(empty.ok && empty.definition.tools).toEqual([]);
  });

  it("trims tool entries and preserves order", () => {
    const result = parse("name: a\ndescription: d\ntools: [' read ', write]");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.tools).toEqual(["read", "write"]);
  });

  it("distinguishes omitted extensions from an empty list and normalizes sources", () => {
    const omitted = parse("name: a\ndescription: d");
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect("extensions" in omitted.definition).toBe(false);

    const empty = parse("name: a\ndescription: d\nextensions: []");
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.definition.extensions).toEqual([]);

    const selected = parse(
      "name: a\ndescription: d\nextensions: [' npm:pi-web-access ', ' path:extensions/pi-web-access ']",
    );
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.definition.extensions).toEqual([
        "npm:pi-web-access",
        "path:extensions/pi-web-access",
      ]);
    }
  });

  it("accepts max_turns boundaries 1 and 10000 (S11)", () => {
    for (const maxTurns of [1, 10000]) {
      const result = parse(`name: a\ndescription: d\nmax_turns: ${maxTurns}`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.definition.maxTurns).toBe(maxTurns);
    }
  });

  it("defaults enabled to true and accepts explicit true (S12)", () => {
    const implicit = parse("name: a\ndescription: d");
    expect(implicit.ok).toBe(true);
    if (implicit.ok) expect(implicit.definition.enabled).toBe(true);

    const explicit = parse("name: a\ndescription: d\nenabled: true");
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.definition.enabled).toBe(true);
  });

  it("preserves body Markdown while trimming outer whitespace", () => {
    const result = parseAgentMetadata(
      doc(
        "name: a\ndescription: d",
        "\n\n# Title\n\n- one\n- two\n\n```\ncode\n```\n\n",
      ),
      REF,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.systemPrompt).toBe(
        "# Title\n\n- one\n- two\n\n```\ncode\n```",
      );
    }
  });
});

describe("line endings and BOM", () => {
  it("parses CRLF documents and normalizes the body to LF", () => {
    const content =
      "---\r\nname: crlf\r\ndescription: Windows file.\r\n---\r\n# T\r\nLine.\r\n";
    const result = parseAgentMetadata(content, REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.name).toBe("crlf");
      expect(result.definition.systemPrompt).toBe("# T\nLine.");
    }
  });

  it("parses documents with a leading BOM", () => {
    const result = parseAgentMetadata(
      `\uFEFF${doc("name: bom\ndescription: Has a BOM.")}`,
      REF,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.name).toBe("bom");
  });

  it("accepts trailing whitespace on delimiters", () => {
    const result = parseAgentMetadata(
      `---   \nname: pad\ndescription: d\n---\t\nBody.\n`,
      REF,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.systemPrompt).toBe("Body.");
  });
});

describe("unknown keys are silently ignored (A3)", () => {
  it("accepts valid files carrying unknown keys of any shape", () => {
    const result = parse(
      "name: a\ndescription: d\nmemory: true\nskills: [x]\nconfig:\n  nested: 1\nnothing: null\ncount: 3",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const definition: AgentDefinition = result.definition;
    expect(definition.name).toBe("a");
    expect("memory" in definition).toBe(false);
    expect(definition.skills).toEqual(["x"]);
    expect("config" in definition).toBe(false);
    expect("warning" in result).toBe(false);
  });

  it("treats prototype-named unknown keys as absent", () => {
    const result = parse("name: a\ndescription: d\nconstructor: 1");
    expect(result.ok).toBe(true);
  });
});

describe("invalid files are rejected whole with one warning (A3)", () => {
  it.each([
    [
      "plain markdown without frontmatter",
      "# Just text\n",
      "missing frontmatter",
    ],
    ["empty file", "", "missing frontmatter"],
    ["unclosed frontmatter", "---\nname: a\n", "frontmatter"],
    ["invalid YAML", "---\na: [unclosed\n---\nBody.\n", "invalid frontmatter"],
    ["list frontmatter root", "---\n- a\n- b\n---\nBody.\n", "frontmatter"],
    ["scalar frontmatter root", "---\njust text\n---\nBody.\n", "frontmatter"],
    ["empty frontmatter", "---\n---\nBody.\n", '"name"'],
    ["missing name", doc("description: d"), '"name"'],
    ["missing description", doc("name: a"), '"description"'],
    ["missing body", doc("name: a\ndescription: d", ""), "body"],
    ["whitespace-only body", doc("name: a\ndescription: d", "  \n \n"), "body"],
    [
      "duplicate YAML keys",
      "---\nname: a\nname: b\ndescription: d\n---\nBody.\n",
      "frontmatter",
    ],
  ])("%s", (_label, content, messagePart) => {
    const result = parseAgentMetadata(content, REF);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect("definition" in result).toBe(false);
    expect(result.warning.path).toBe(REF.sourcePath);
    expect(result.warning.message).toContain(messagePart);
  });

  it.each([
    ["empty", ""],
    ["leading dash", "-lead"],
    ["leading underscore", "_lead"],
    ["space", "has space"],
    ["punctuation", "tool!"],
    ["too long", "a".repeat(65)],
  ])("invalid name: %s", (_label, name) => {
    const result = parse(`name: '${name}'\ndescription: d`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"name"');
  });

  it.each([
    ["number", "name: 123\ndescription: d"],
    ["boolean", "name: true\ndescription: d"],
    ["null", "name: null\ndescription: d"],
    ["array", "name: [a]\ndescription: d"],
  ])("invalid name type: %s", (_label, frontmatter) => {
    const result = parse(frontmatter);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"name"');
  });

  it.each([
    ["empty", "''"],
    ["whitespace-only", "'   '"],
    ["too long", `'${"d".repeat(513)}'`],
    ["number", "123"],
    ["boolean", "true"],
    ["null", "null"],
    ["array", "[d]"],
  ])("invalid description: %s", (_label, description) => {
    const result = parse(`name: a\ndescription: ${description}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"description"');
  });

  it.each([
    ["empty", "''"],
    ["whitespace-only", "'   '"],
    ["number", "123"],
    ["boolean", "true"],
    ["null", "null"],
  ])("invalid model: %s", (_label, model) => {
    const result = parse(`name: a\ndescription: d\nmodel: ${model}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"model"');
  });

  it.each([
    ["wrong case", "Medium"],
    ["unknown", "ultra"],
    ["empty", "''"],
    ["null", "null"],
    ["number", "42"],
  ])("invalid thinking: %s", (_label, thinking) => {
    const result = parse(`name: a\ndescription: d\nthinking: ${thinking}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"thinking"');
  });

  it.each([
    ["string instead of array", "tools: read"],
    ["object instead of array", "tools: {read: true}"],
    ["empty entry", "tools: ['']"],
    ["blank entry", "tools: ['   ']"],
    ["number entry", "tools: [42]"],
    ["null entry", "tools: [null]"],
    ["boolean entry", "tools: [true]"],
    ["duplicate entries", "tools: [read, read]"],
    ["duplicates after trimming", "tools: [read, ' read ']"],
  ])("invalid tools: %s", (_label, tools) => {
    const result = parse(`name: a\ndescription: d\n${tools}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"tools"');
  });

  it.each([
    ["string instead of array", "extensions: npm:pi-web-access"],
    ["empty entry", "extensions: ['']"],
    ["unsupported source", "extensions: [git:example/repo]"],
    ["blank npm", "extensions: ['npm:']"],
    ["malformed npm", "extensions: ['npm:@scope']"],
    ["npm exact version", "extensions: ['npm:pi-web-access@1.0.0']"],
    ["npm version range", "extensions: ['npm:@scope/pi-web-access@^1.0.0']"],
    ["npm tag", "extensions: ['npm:pi-web-access@next']"],
    ["absolute path", "extensions: ['path:/tmp/extension']"],
    ["windows absolute path", "extensions: ['path:C:\\\\tmp\\\\extension']"],
    ["traversal", "extensions: ['path:extensions/../outside']"],
    ["duplicate", "extensions: [npm:pi-web-access, npm:pi-web-access]"],
    [
      "duplicate after trim",
      "extensions: [npm:pi-web-access, ' npm:pi-web-access ']",
    ],
  ])("invalid extensions: %s", (_label, extensions) => {
    const result = parse(`name: a\ndescription: d\n${extensions}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"extensions"');
  });

  it.each([
    ["zero", "0"],
    ["above max", "10001"],
    ["fraction", "1.5"],
    ["string", "'5'"],
    ["boolean", "true"],
    ["null", "null"],
    ["NaN", ".nan"],
  ])("invalid max_turns: %s", (_label, maxTurns) => {
    const result = parse(`name: a\ndescription: d\nmax_turns: ${maxTurns}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"max_turns"');
  });

  it.each([
    ["string false", "'false'"],
    ["string true", "'true'"],
    ["one", "1"],
    ["zero", "0"],
    ["null", "null"],
  ])("invalid enabled: %s", (_label, enabled) => {
    const result = parse(`name: a\ndescription: d\nenabled: ${enabled}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning.message).toContain('"enabled"');
  });

  it("never partially applies an invalid file", () => {
    const result = parse(
      "name: valid-name\ndescription: Valid.\nmodel: opus\nmax_turns: 0",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect("definition" in result).toBe(false);
    expect(Object.keys(result)).toEqual(["ok", "warning"]);
  });

  it("redacts file contents, body text, and invalid values from warnings", () => {
    const nameSecret = "sekret-invalid-name!!!";
    const modelSecret = "sk-secret-hunter2-model";
    const bodySecret = "body-secret-token-abc123";
    const result = parseAgentMetadata(
      doc(
        `name: '${nameSecret}'\ndescription: d\nmodel: '${modelSecret}'`,
        `${bodySecret}\n`,
      ),
      REF,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(nameSecret);
    expect(serialized).not.toContain(modelSecret);
    expect(serialized).not.toContain(bodySecret);
    expect(serialized).toContain(REF.sourcePath);
  });

  it("redacts other fields when the body is the failure cause", () => {
    const modelSecret = "sk-secret-hunter2-model";
    const result = parseAgentMetadata(
      doc(
        `name: fine\ndescription: Fine.\nmodel: '${modelSecret}'`,
        "   \n  \n",
      ),
      { source: "global", sourcePath: "/g/agents/empty-body.md" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warning.path).toBe("/g/agents/empty-body.md");
    expect(result.warning.message).toContain("body");
    expect(JSON.stringify(result)).not.toContain(modelSecret);
  });
});
