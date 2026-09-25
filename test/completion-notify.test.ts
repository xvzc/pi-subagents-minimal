import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createTools } from "../src/index.js";
import {
  COMPLETION_MESSAGE_TYPE,
  createHostNotifier,
} from "../src/runtime/completion-notify.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

function rendered(
  component: { render(width: number): string[] } | undefined,
): string {
  return component?.render(200).join("\n").trimEnd() ?? "";
}

describe("hidden async completion signal", () => {
  it("sends a minimal hidden follow-up that stays in model context without child output", () => {
    const sendMessage = vi.fn();
    const notifier = createHostNotifier({ sendMessage } as unknown as Pick<
      ExtensionAPI,
      "sendMessage"
    >);
    notifier.notify({ sessionId: "00000000-0000-0006", status: "completed" });

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      {
        customType: COMPLETION_MESSAGE_TYPE,
        content: expect.stringContaining("00000000-0000-0006"),
        display: false,
        details: { session_id: "00000000-0000-0006", status: "completed" },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    const sent = sendMessage.mock.calls[0]![0];
    expect(sent.content).toContain("completed");
    expect(sent.content).toContain("subagent_output");
    expect(sent.content).toContain("00000000-0000-0006");
    expect(JSON.stringify(sent)).not.toContain("full raw output");
    expect(sent.details).not.toHaveProperty("output");
    expect(sent.details).not.toHaveProperty("error");
    expect(sent.details).not.toHaveProperty("usage");
    expect(sent.details).not.toHaveProperty("model");
    expect(sent.details).not.toHaveProperty("thinking");
    expect(sent.details).not.toHaveProperty("agent");
    const projected = convertToLlm([
      {
        role: "custom",
        customType: COMPLETION_MESSAGE_TYPE,
        content: sent.content,
        display: false,
        details: sent.details,
        timestamp: 1,
      },
    ]);
    expect(projected).toHaveLength(1);
    expect(JSON.stringify(projected)).toContain("00000000-0000-0006");
  });

  it("never shows a UI toast", () => {
    const sendMessage = vi.fn();
    const ui = { notify: vi.fn() };
    const notifier = createHostNotifier({ sendMessage } as unknown as Pick<
      ExtensionAPI,
      "sendMessage"
    >);
    notifier.notify({ sessionId: "00000000-0000-000e", status: "failed" });
    expect(ui.notify).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0].display).toBe(false);
  });
});

describe("subagent_output Agent Output rendering", () => {
  function outputTool() {
    return createTools({
      sessions: {
        call: async () => ({}),
        output: async () => ({}),
        shutdown: async () => undefined,
      },
    }).find((tool) => tool.name === "subagent_output")!;
  }

  function render(details: unknown, expanded: boolean): string {
    const tool = outputTool();
    return rendered(
      tool.renderResult!(
        { content: [], details } as any,
        { expanded, isPartial: false } as any,
        theme as any,
        {} as any,
      ),
    );
  }

  it("renders completed output as a compact row with expandable sanitized output", () => {
    expect(
      render(
        {
          agent: "reviewer",
          status: "completed",
          output: "answer\n\u001b[31msafe",
        },
        false,
      ),
    ).toBe(
      "<success>❮</success> <toolTitle>Agent Output</toolTitle><dim> · reviewer</dim>",
    );
    expect(
      render(
        {
          agent: "reviewer",
          status: "completed",
          output: "answer\n\u001b[31msafe",
        },
        true,
      ),
    ).toContain("safe</toolOutput>");
  });

  it("renders terminal errors and bare statuses safely", () => {
    expect(
      render(
        {
          agent: "reviewer",
          status: "failed",
          error: { message: "failed safely" },
        },
        true,
      ),
    ).toContain("failed safely");
    expect(render({ agent: "reviewer", status: "stopped" }, true)).toContain(
      "stopped",
    );
    expect(
      render(
        { agent: "reviewer", status: "failed", error: "terminal failure" },
        false,
      ),
    ).toContain("terminal failure");
  });

  it("renders malformed and error envelopes without throwing", () => {
    expect(() => render(undefined, false)).not.toThrow();
    expect(() => render(null, true)).not.toThrow();
    expect(() => render("oops", true)).not.toThrow();
    expect(
      render(
        { error: { code: "SESSION_NOT_FOUND", message: "missing" } },
        true,
      ),
    ).toContain("missing");
    expect(render("oops", true)).toContain("Terminal status unavailable.");
  });

  it("truncates oversized expanded bodies", () => {
    const capped = render(
      { agent: "reviewer", output: "x".repeat(100_001) },
      true,
    );
    expect(capped).toContain("… (output truncated for display)");
    expect(capped).not.toContain("x".repeat(100_001));
  });
});
