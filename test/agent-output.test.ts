import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension, { createTools } from "../src/index.js";
import { COMPLETION_MESSAGE_TYPE } from "../src/runtime/completion-notify.js";
import { renderAgentOutput } from "../src/runtime/agent-output.js";
import type { ToolServices } from "../src/types.js";

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

const services: ToolServices = {
  sessions: {
    call: async () => ({}),
    output: async () => ({}),
    shutdown: async () => undefined,
  },
  registry: { list: async () => ({ agents: [] }) },
  status: { status: async () => ({}) },
};

function renderOutputResult(details: unknown, expanded: boolean) {
  const tool = createTools(services).find(
    (entry) => entry.name === "subagent_output",
  )!;
  return tool.renderResult!(
    { content: [], details } as any,
    { expanded, isPartial: false } as any,
    theme,
    {} as any,
  );
}

describe("subagent_output Agent Output rendering", () => {
  it("registers no message renderer and no turn_end entry hook", async () => {
    const registeredEvents: string[] = [];
    const appendEntry = vi.fn();
    const sendMessage = vi.fn();
    const registerMessageRenderer = vi.fn();
    await extension(
      {
        registerTool: () => undefined,
        registerMessageRenderer,
        registerEntryRenderer: () => {
          throw new Error("foreground entry renderer must not be registered");
        },
        appendEntry,
        sendMessage,
        on: (name: string) => {
          registeredEvents.push(name);
        },
      } as unknown as ExtensionAPI,
      services,
      { agentDir: "/missing", cwd: "/missing" },
    );

    expect(registerMessageRenderer).not.toHaveBeenCalled();
    expect(registeredEvents).toContain("session_shutdown");
    expect(registeredEvents).not.toContain("turn_end");
    expect(registeredEvents).not.toContain("tool_execution_end");
    expect(registeredEvents).not.toContain("message_end");
    expect(appendEntry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses the same exact collapsed and expanded success, error, and status rendering", () => {
    const success = {
      agent: "reviewer",
      status: "completed",
      output: "answer\n\u001b[31msafe",
    };
    const error = {
      agent: "reviewer",
      status: "failed",
      error: "failed\n\u001b[31msafely",
    };
    const status = { agent: "reviewer", status: "stopped" };
    const failedHeading =
      "<error>x</error> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>";

    expect(rendered(renderOutputResult(success, false))).toBe(
      "<success>❮</success> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>",
    );
    expect(semanticLines(renderOutputResult(success, true))).toEqual([
      "<success>❮</success> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>",
      "<toolOutput>answer",
      "safe</toolOutput>",
    ]);
    // Failure headings carry only glyph/title/metadata; the reason renders as
    // an indented body even when collapsed.
    expect(semanticLines(renderOutputResult(error, false))).toEqual([
      failedHeading,
      "<error>failed safely</error>",
    ]);
    expect(semanticLines(renderOutputResult(error, true))).toEqual([
      failedHeading,
      "<error>failed safely</error>",
      "<toolOutput>failed",
      "safely</toolOutput>",
    ]);
    expect(semanticLines(renderOutputResult(status, false))).toEqual([
      failedHeading,
      "<error>stopped</error>",
    ]);
    // Status-only failures have nothing beyond the reason, so expanded does
    // not duplicate it.
    expect(semanticLines(renderOutputResult(status, true))).toEqual([
      failedHeading,
      "<error>stopped</error>",
    ]);
    const capped = rendered(
      renderOutputResult(
        { agent: "reviewer", output: "x".repeat(100_001) },
        true,
      ),
    );
    expect(capped).toContain("… (output truncated for display)");
    expect(capped).not.toContain("x".repeat(100_001));
  });

  it("bounds the always-visible reason and expanded bodies", () => {
    const hugeError = "x".repeat(100_100);
    const collapsed =
      renderOutputResult(
        { agent: "reviewer", status: "failed", error: { message: hugeError } },
        false,
      )
        ?.render(200_000)
        .join("\n") ?? "";
    expect(collapsed).toContain(`${"x".repeat(119)}…</error>`);
    expect(collapsed).not.toContain(`${"x".repeat(120)}</error>`);
    expect(collapsed).not.toContain(hugeError);
    const text =
      renderOutputResult(
        { agent: "reviewer", status: "failed", error: { message: hugeError } },
        true,
      )
        ?.render(200_000)
        .join("\n") ?? "";
    expect(text).toContain(`${"x".repeat(119)}…</error>`);
    expect(text).not.toContain(`${"x".repeat(120)}</error>`);
    expect(text).toContain("… (output truncated for display)");
    expect(text).not.toContain(hugeError);
  });

  it("keeps the failure reason visible while prioritizing partial output when expanded", () => {
    const details = {
      agent: "reviewer",
      status: "failed",
      output: "useful partial output",
      error: "terminal failure",
    };
    const collapsed = rendered(renderOutputResult(details, false));
    expect(collapsed).not.toContain("<error> · terminal failure</error>");
    expect(collapsed).toContain("<error>terminal failure</error>");
    const text = rendered(renderOutputResult(details, true));
    expect(text).toContain("<error>terminal failure</error>");
    expect(text).toContain("<toolOutput>useful partial output</toolOutput>");
    expect(text).not.toContain("<toolOutput>terminal failure</toolOutput>");
  });

  it("renders malformed and error envelopes without throwing", () => {
    expect(() => renderOutputResult(undefined, false)).not.toThrow();
    expect(() => renderOutputResult("oops", true)).not.toThrow();
    expect(
      rendered(
        renderOutputResult(
          { error: { code: "SESSION_NOT_FOUND", message: "missing" } },
          true,
        ),
      ),
    ).toContain("missing");
    expect(
      rendered(
        renderOutputResult(
          { error: { code: "SESSION_NOT_FOUND", message: "missing" } },
          false,
        ),
      ),
    ).toContain("<error>x</error>");
    expect(rendered(renderOutputResult("oops", true))).toContain(
      "Terminal status unavailable.",
    );
  });

  it("uses x for terminal failure statuses and ❮ for non-failure statuses", () => {
    for (const status of ["failed", "aborted", "stopped"] as const) {
      expect(
        semanticLines(renderOutputResult({ agent: "reviewer", status }, false)),
      ).toEqual([
        `<error>x</error> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>`,
        `<error>${status}</error>`,
      ]);
    }
    for (const status of ["completed", "queued", "running"] as const) {
      expect(
        rendered(renderOutputResult({ agent: "reviewer", status }, false)),
      ).toBe(
        `<success>❮</success> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>`,
      );
    }
    expect(
      rendered(
        renderOutputResult(
          { agent: "reviewer", status: "completed", error: "boom" },
          false,
        ),
      ),
    ).toContain("<error>x</error>");
  });

  it("shows an indented sanitized reason even when collapsed", () => {
    const component = renderOutputResult(
      {
        agent: "reviewer",
        status: "failed",
        error: "boom\n\u001b[31mwith\u0007controls",
      },
      false,
    );
    const lines = component?.render(200) ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Agent Output");
    expect(lines[0]).not.toContain("boom");
    expect(lines[1]?.startsWith("  ")).toBe(true);
    expect(lines[1]).toContain("<error>boom with controls</error>");
  });

  it("caps the always-visible reason at 120 characters", () => {
    const lines = semanticLines(
      renderOutputResult(
        { agent: "reviewer", status: "failed", error: "y".repeat(200) },
        false,
      ),
    );
    expect(lines).toEqual([
      "<error>x</error> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>",
      `<error>${"y".repeat(119)}…</error>`,
    ]);
  });

  it("does not duplicate identical error text when expanded", () => {
    const collapsed = semanticLines(
      renderOutputResult(
        { agent: "reviewer", status: "failed", error: "boom" },
        false,
      ),
    );
    const expanded = semanticLines(
      renderOutputResult(
        { agent: "reviewer", status: "failed", error: "boom" },
        true,
      ),
    );
    expect(expanded).toEqual(collapsed);
    const identical = rendered(
      renderOutputResult(
        { agent: "reviewer", status: "failed", output: "same", error: "same" },
        true,
      ),
    );
    expect(identical.match(/same/g)?.length).toBe(1);
  });

  it("does not duplicate output that reformats to a status-only reason", () => {
    const lines = semanticLines(
      renderOutputResult(
        { agent: "reviewer", status: "failed", output: "failed" },
        true,
      ),
    );
    expect(lines).toEqual([
      "<error>x</error> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>",
      "<error>failed</error>",
    ]);
  });

  it("falls back to error code, status, or a generic label", () => {
    expect(
      semanticLines(
        renderOutputResult(
          { error: { code: "SESSION_NOT_FOUND", message: "" } },
          false,
        ),
      ),
    ).toEqual([
      "<error>x</error> <toolTitle>Agent Output</toolTitle>",
      "<error>SESSION_NOT_FOUND</error>",
    ]);
    expect(
      semanticLines(
        renderOutputResult({ agent: "reviewer", status: "aborted" }, false),
      )[1],
    ).toBe("<error>aborted</error>");
    expect(
      semanticLines(renderOutputResult({ error: 123 } as never, false)),
    ).toEqual([
      "<error>x</error> <toolTitle>Agent Output</toolTitle>",
      "<error>Agent failed.</error>",
    ]);
  });

  it("omits blank provider text and sanitizes carriage returns in expanded UI", () => {
    const details = {
      agent: "reviewer",
      status: "failed",
      error: "turn failed",
    };
    const baseline = rendered(renderAgentOutput(details, true, theme));
    expect(
      rendered(renderAgentOutput(details, true, theme, "", " \r\t ")),
    ).toBe(baseline);
    const displayed = rendered(
      renderAgentOutput(details, true, theme, "", "first\rsecond\u001b[31m"),
    );
    expect(displayed).toContain("first second");
    expect(displayed).not.toContain("\r");
    expect(displayed).not.toContain("\u001b");
    expect(
      rendered(renderAgentOutput(details, false, theme, "", "first\rsecond")),
    ).toBe(rendered(renderAgentOutput(details, false, theme)));
  });

  it("keeps the completion custom type for hidden model-context delivery", () => {
    expect(COMPLETION_MESSAGE_TYPE).toBe("pi-subagents-minimal:completion");
  });
});
