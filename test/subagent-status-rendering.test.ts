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

function statusTool() {
  return createTools({}).find((entry) => entry.name === "subagent_status")!;
}

function renderStatusResult(details: unknown, expanded: boolean) {
  return statusTool().renderResult!(
    { content: [], details } as any,
    { expanded, isPartial: false } as any,
    theme,
    {} as any,
  );
}

const HEADING = (counts: string) =>
  `<success>✓</success> <toolTitle>Agent Status</toolTitle><dim>${counts}</dim>`;

describe("subagent_status Agent Status rendering", () => {
  it("hides the default tool call row", () => {
    const call = statusTool().renderCall!({} as any, theme, {} as any);
    expect(call.render(200)).toEqual([]);
  });

  it("renders the exact collapsed and expanded shape", () => {
    const details = {
      active_sessions: [
        {
          session_id: "00000000-0000-0008",
          agent: "reviewer",
          status: "running",
        },
      ],
      recent_sessions: [
        {
          session_id: "00000000-0000-0015",
          agent: "contributor",
          status: "completed",
        },
        {
          session_id: "00000000-0000-0066",
          agent: "reviewer",
          status: "failed",
        },
      ],
    };
    expect(rendered(renderStatusResult(details, false))).toBe(
      HEADING(" · 1 active · 2 recent"),
    );
    expect(semanticLines(renderStatusResult(details, true))).toEqual([
      HEADING(" · 1 active · 2 recent"),
      "<toolOutput>●</toolOutput> <toolOutput>reviewer · running · 00000000-0000-0008</toolOutput>",
      "<toolOutput>✓</toolOutput> <toolOutput>contributor · completed · 00000000-0000-0015</toolOutput>",
      "<warning>x</warning> <warning>reviewer · failed · 00000000-0000-0066</warning>",
    ]);
  });

  it("uses sensible markers and colors for every supported status", () => {
    const details = {
      active_sessions: [
        { session_id: "00000000-0000-0043", agent: "worker", status: "queued" },
        {
          session_id: "00000000-0000-0046",
          agent: "worker",
          status: "running",
        },
      ],
      recent_sessions: [
        {
          session_id: "00000000-0000-0011",
          agent: "worker",
          status: "completed",
        },
        { session_id: "00000000-0000-001c", agent: "worker", status: "failed" },
        {
          session_id: "00000000-0000-0051",
          agent: "worker",
          status: "stopped",
        },
        {
          session_id: "00000000-0000-0006",
          agent: "worker",
          status: "aborted",
        },
      ],
    };
    expect(semanticLines(renderStatusResult(details, true))).toEqual([
      HEADING(" · 2 active · 4 recent"),
      "<toolOutput>○</toolOutput> <toolOutput>worker · queued · 00000000-0000-0043</toolOutput>",
      "<toolOutput>●</toolOutput> <toolOutput>worker · running · 00000000-0000-0046</toolOutput>",
      "<toolOutput>✓</toolOutput> <toolOutput>worker · completed · 00000000-0000-0011</toolOutput>",
      "<warning>x</warning> <warning>worker · failed · 00000000-0000-001c</warning>",
      "<warning>■</warning> <warning>worker · stopped · 00000000-0000-0051</warning>",
      "<warning>!</warning> <warning>worker · aborted · 00000000-0000-0006</warning>",
    ]);
  });

  it("renders a compact empty state", () => {
    const details = { active_sessions: [], recent_sessions: [] };
    expect(rendered(renderStatusResult(details, false))).toBe(
      HEADING(" · no sessions"),
    );
    expect(semanticLines(renderStatusResult(details, true))).toEqual([
      HEADING(" · no sessions"),
      "<toolOutput>No subagent sessions.</toolOutput>",
    ]);
  });

  it("renders error envelopes with an always-visible reason", () => {
    const details = {
      error: { code: "SESSION_NOT_FOUND", message: "missing" },
    };
    expect(semanticLines(renderStatusResult(details, false))).toEqual([
      "<error>x</error> <toolTitle>Agent Status</toolTitle>",
      "<error>missing</error>",
    ]);
    expect(semanticLines(renderStatusResult(details, true))).toEqual([
      "<error>x</error> <toolTitle>Agent Status</toolTitle>",
      "<error>missing</error>",
    ]);
  });

  it("renders malformed payloads as the empty state without throwing", () => {
    for (const details of [
      undefined,
      "oops",
      42,
      [],
      { active_sessions: "nope" },
      { active_sessions: [{ agent: 1 }] },
    ]) {
      expect(() => renderStatusResult(details, false)).not.toThrow();
      expect(() => renderStatusResult(details, true)).not.toThrow();
      expect(rendered(renderStatusResult(details, false))).toBe(
        HEADING(" · no sessions"),
      );
    }
  });

  it("sanitizes terminal content and caps untrusted display", () => {
    const details = {
      active_sessions: [
        {
          session_id: "00000000-0000-003a",
          agent: "bad\nagent\u001b[31m",
          status: "running",
        },
      ],
      recent_sessions: [],
    };
    const lines = semanticLines(renderStatusResult(details, true));
    expect(lines).toEqual([
      HEADING(" · 1 active · 0 recent"),
      "<toolOutput>●</toolOutput> <toolOutput>bad agent · running · 00000000-0000-003a</toolOutput>",
    ]);
    const long = renderStatusResult(
      {
        active_sessions: [
          {
            session_id: "00000000-0000-003a",
            agent: `a${"x".repeat(200)}`,
            status: "running",
          },
        ],
        recent_sessions: [],
      },
      true,
    );
    const text = rendered(long);
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(200));
  });

  it("falls back for unknown statuses without throwing", () => {
    const details = {
      active_sessions: [
        { session_id: "00000000-0000-003a", agent: "worker", status: "weird" },
      ],
      recent_sessions: [],
    };
    expect(semanticLines(renderStatusResult(details, true))).toEqual([
      HEADING(" · 1 active · 0 recent"),
      "<warning>?</warning> <warning>worker · weird · 00000000-0000-003a</warning>",
    ]);
  });

  it("round-trips the live status payload through execute", async () => {
    const payload = {
      active_sessions: [
        {
          session_id: "00000000-0000-0004",
          agent: "reviewer",
          status: "queued",
        },
      ],
      recent_sessions: [],
    };
    const tool = createTools({ status: { status: async () => payload } }).find(
      (entry) => entry.name === "subagent_status",
    )!;
    const result = await tool.execute(
      "status",
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
    ).toBe(HEADING(" · 1 active · 0 recent"));
  });
});
