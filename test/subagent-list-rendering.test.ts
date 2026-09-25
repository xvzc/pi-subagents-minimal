import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createTools } from "../src/index.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as Theme;

function rendered(
  component: { render(width: number): string[] } | undefined,
): string {
  return component?.render(200).join("\n").trimEnd() ?? "";
}

function semanticLines(
  component: { render(width: number): string[] } | undefined,
): string[] {
  return rendered(component)
    .split("\n")
    .map((line) => line.trimEnd().trimStart());
}

function listTool() {
  return createTools({}).find((entry) => entry.name === "subagent_list")!;
}

function renderListResult(details: unknown, expanded: boolean) {
  return listTool().renderResult!(
    { content: [], details } as any,
    { expanded, isPartial: false } as any,
    theme,
    {} as any,
  );
}

const HEADING = (counts: string) =>
  `<success>✓</success> <toolTitle>Agent List</toolTitle><dim>${counts}</dim>`;

const ESC = String.fromCharCode(27);
const LF = String.fromCharCode(10);

describe("subagent_list Agent List rendering", () => {
  it("hides the default tool call row", () => {
    const call = listTool().renderCall!({} as any, theme, {} as any);
    expect(call.render(200)).toEqual([]);
  });

  it("renders the exact collapsed and expanded shape", () => {
    const details = {
      agents: [
        {
          name: "architect",
          description: "Read-only architecture and design advisor.",
          model: "opus",
          thinking: "high",
          max_turns: 10,
          tools: ["read", "grep", "find", "ls"],
          extensions: ["npm:pi-web-access"],
          source: "global",
        },
      ],
    };
    expect(rendered(renderListResult(details, false))).toBe(
      HEADING(" · 1 enabled"),
    );
    expect(semanticLines(renderListResult(details, true))).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>architect · global</dim>",
      "<toolOutput>Read-only architecture and design advisor.</toolOutput>",
      "<dim>model: opus · thinking: high · max turns: 10</dim>",
      "<dim>tools: read, grep, find, ls</dim>",
      "<dim>extensions: npm:pi-web-access</dim>",
    ]);
  });

  it("counts five enabled agents in the collapsed heading", () => {
    const details = {
      agents: [
        { name: "a", source: "global" },
        { name: "b", source: "global" },
        { name: "c", source: "project" },
        { name: "d", source: "project" },
        { name: "e", source: "global" },
      ],
    };
    expect(rendered(renderListResult(details, false))).toBe(
      HEADING(" · 5 enabled"),
    );
  });

  it("includes only metadata fields actually present", () => {
    const full = {
      agents: [
        {
          name: "a",
          source: "global",
          model: "opus",
          thinking: "high",
          max_turns: 10,
        },
      ],
    };
    expect(semanticLines(renderListResult(full, true))).toContain(
      "<dim>model: opus · thinking: high · max turns: 10</dim>",
    );

    const partial = {
      agents: [{ name: "b", source: "project", model: "sonnet" }],
    };
    expect(semanticLines(renderListResult(partial, true))).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>b · project</dim>",
      "<dim>model: sonnet</dim>",
    ]);

    const bare = { agents: [{ name: "c", source: "global" }] };
    expect(semanticLines(renderListResult(bare, true))).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>c · global</dim>",
    ]);
  });

  it("preserves omitted versus empty tools and extensions", () => {
    const omitted = {
      agents: [
        { name: "aaa", description: "Omitted tools.", source: "global" },
      ],
    };
    expect(semanticLines(renderListResult(omitted, true))).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>aaa · global</dim>",
      "<toolOutput>Omitted tools.</toolOutput>",
    ]);

    const empty = {
      agents: [
        {
          name: "bbb",
          description: "No tools or extensions.",
          tools: [],
          extensions: [],
          source: "global",
        },
      ],
    };
    expect(semanticLines(renderListResult(empty, true))).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>bbb · global</dim>",
      "<toolOutput>No tools or extensions.</toolOutput>",
      "<dim>tools: (none)</dim>",
      "<dim>extensions: (none)</dim>",
    ]);
  });

  it("renders all, none, and named capability policies", () => {
    const details = {
      agents: [
        {
          name: "worker",
          source: "global",
          tools: true,
          disallowed_tools: [],
          skills: ["review", "deploy"],
          disallowed_skills: ["deploy"],
        },
      ],
    };
    expect(semanticLines(renderListResult(details, true))).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>worker · global</dim>",
      "<dim>tools: all</dim>",
      "<dim>disallowed tools: (none)</dim>",
      "<dim>skills: review, deploy</dim>",
      "<dim>disallowed skills: deploy</dim>",
    ]);
  });

  it("renders a compact empty state", () => {
    const details = { agents: [] };
    expect(rendered(renderListResult(details, false))).toBe(
      HEADING(" · no agents"),
    );
    expect(semanticLines(renderListResult(details, true))).toEqual([
      HEADING(" · no agents"),
      "<toolOutput>No agents available.</toolOutput>",
    ]);
  });

  it("appends singular and plural warning counts and renders warning rows", () => {
    const single = {
      agents: [{ name: "good", source: "global" }],
      warnings: [{ path: "/agents/bad.md", message: "missing description" }],
    };
    expect(rendered(renderListResult(single, false))).toBe(
      HEADING(" · 1 enabled · 1 warning"),
    );
    expect(semanticLines(renderListResult(single, true))).toEqual([
      HEADING(" · 1 enabled · 1 warning"),
      "<accent>•</accent> <dim>good · global</dim>",
      "<warning>!</warning> <dim>/agents/bad.md · missing description</dim>",
    ]);

    const plural = {
      agents: [],
      warnings: [
        { path: "/agents/a.md", message: "first problem" },
        { path: "/agents/b.md", message: "second problem" },
      ],
    };
    expect(rendered(renderListResult(plural, false))).toBe(
      HEADING(" · no agents · 2 warnings"),
    );
    expect(semanticLines(renderListResult(plural, true))).toEqual([
      HEADING(" · no agents · 2 warnings"),
      "<warning>!</warning> <dim>/agents/a.md · first problem</dim>",
      "<warning>!</warning> <dim>/agents/b.md · second problem</dim>",
    ]);
  });

  it("renders error envelopes with an always-visible reason", () => {
    const details = {
      error: { code: "INTERNAL_ERROR", message: "registry blew up" },
    };
    expect(semanticLines(renderListResult(details, false))).toEqual([
      "<error>x</error> <toolTitle>Agent List</toolTitle>",
      "<error>registry blew up</error>",
    ]);
    expect(semanticLines(renderListResult(details, true))).toEqual([
      "<error>x</error> <toolTitle>Agent List</toolTitle>",
      "<error>registry blew up</error>",
    ]);
  });

  it("falls back to error code or a generic label", () => {
    expect(
      semanticLines(
        renderListResult(
          { error: { code: "INTERNAL_ERROR", message: "" } },
          false,
        ),
      ),
    ).toEqual([
      "<error>x</error> <toolTitle>Agent List</toolTitle>",
      "<error>INTERNAL_ERROR</error>",
    ]);
    expect(
      semanticLines(
        renderListResult({ error: { code: "", message: "" } }, false),
      ),
    ).toEqual([
      "<error>x</error> <toolTitle>Agent List</toolTitle>",
      "<error>Agent list failed.</error>",
    ]);
  });

  it("renders malformed payloads as the empty state without throwing", () => {
    for (const details of [
      undefined,
      "oops",
      42,
      [],
      { agents: "nope" },
      { agents: [{ name: 1 }] },
      { agents: [{ description: "nameless" }] },
      null,
    ]) {
      expect(() => renderListResult(details, false)).not.toThrow();
      expect(() => renderListResult(details, true)).not.toThrow();
      expect(rendered(renderListResult(details, false))).toBe(
        HEADING(" · no agents"),
      );
    }
    expect(semanticLines(renderListResult({ agents: "nope" }, true))).toEqual([
      HEADING(" · no agents"),
      "<toolOutput>No agents available.</toolOutput>",
    ]);
  });

  it("sanitizes terminal content and caps untrusted display", () => {
    const details = {
      agents: [
        {
          name: "bad" + LF + "agent" + ESC + "[31m",
          description: "desc" + LF + "line" + ESC + "[31m",
          source: "global",
        },
      ],
    };
    const lines = semanticLines(renderListResult(details, true));
    expect(lines).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>bad agent · global</dim>",
      "<toolOutput>desc line</toolOutput>",
    ]);
    expect(rendered(renderListResult(details, true))).not.toContain(ESC);

    const long = renderListResult(
      { agents: [{ name: "a" + "x".repeat(200), source: "global" }] },
      true,
    );
    const text = rendered(long);
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(200));
  });

  it("round-trips the live list payload through execute", async () => {
    const payload = {
      agents: [
        {
          name: "architect",
          description: "Read-only architecture and design advisor.",
          source: "global",
        },
      ],
    };
    const tool = createTools({ registry: { list: async () => payload } }).find(
      (entry) => entry.name === "subagent_list",
    )!;
    const result = await tool.execute(
      "list",
      {},
      undefined,
      undefined,
      {} as any,
    );
    expect(result.details).toEqual(payload);
    expect(
      rendered(
        tool.renderResult!(
          result as any,
          { expanded: false, isPartial: false } as any,
          theme,
          {} as any,
        ),
      ),
    ).toBe(HEADING(" · 1 enabled"));
    expect(
      semanticLines(
        tool.renderResult!(
          result as any,
          { expanded: true, isPartial: false } as any,
          theme,
          {} as any,
        ),
      ),
    ).toEqual([
      HEADING(" · 1 enabled"),
      "<accent>•</accent> <dim>architect · global</dim>",
      "<toolOutput>Read-only architecture and design advisor.</toolOutput>",
    ]);
  });
});
