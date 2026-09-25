import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTools } from "../src/index.js";
import { AgentsView, type AgentViewRow } from "../src/runtime/agents-view.js";
import type { SubagentWaitParams } from "../src/schemas.js";

function theme(): Theme {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => text,
  } as Theme;
}

function waitTool() {
  return createTools({
    sessions: {
      call: async () => ({}),
      output: async () => ({}),
      shutdown: async () => undefined,
    } as any,
  }).find((tool) => tool.name === "subagent_wait")!;
}

function renderContext(args: SubagentWaitParams, toolCallId = "wait") {
  return {
    args,
    toolCallId,
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: "/project",
    executionStarted: false,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
  } as any;
}

function rendered(component: { render(width: number): string[] }): string {
  return component.render(200).join("\n").trimEnd();
}

const EXPECTED_FRAMES = ["⠐", "⠰", "⠴", "⠶", "⠶", "⠦", "⠖", "⠒", "⠐"];

afterEach(() => {
  vi.useRealTimers();
});

describe("subagent_wait rendering", () => {
  it("is labeled consistently as Agent Wait", () => {
    expect(waitTool().label).toBe("Agent Wait");
  });

  it("shows an animated pending spinner while waiting", () => {
    vi.useFakeTimers();
    const tool = waitTool();
    const args = {
      session_ids: ["00000000-0000-0006", "00000000-0000-000e"],
    } as SubagentWaitParams;
    const context = renderContext(args);
    const call = tool.renderCall!(args, theme(), context);

    expect(rendered(call)).toBe(
      "<accent>⠐</accent> <toolTitle>Agent Wait</toolTitle><dim> · 2 sessions</dim>",
    );
    expect(vi.getTimerCount()).toBe(1);

    const seen = new Set<string>([rendered(call)]);
    for (let tick = 0; tick < EXPECTED_FRAMES.length; tick += 1) {
      vi.advanceTimersByTime(80);
      seen.add(rendered(call));
    }
    // Full cycle covers exactly the nine required frames with no blank.
    expect(seen).toEqual(
      new Set(
        EXPECTED_FRAMES.map(
          (frame) =>
            `<accent>${frame}</accent> <toolTitle>Agent Wait</toolTitle><dim> · 2 sessions</dim>`,
        ),
      ),
    );
    for (const line of seen) {
      expect(line).toContain("Agent Wait");
      expect(line).not.toContain("<accent> </accent>");
    }
    expect(context.invalidate).toHaveBeenCalled();

    // Partial results stay empty while the call row carries the spinner.
    expect(
      tool.renderResult!(
        { content: [], details: {} },
        { expanded: false, isPartial: true },
        theme(),
        context,
      ).render(200),
    ).toEqual([]);

    // Settlement stops the timer and hides the call row; the result carries it.
    context.isPartial = false;
    context.lastComponent = call;
    expect(tool.renderCall!(args, theme(), context).render(200)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a check mark when completed", () => {
    vi.useFakeTimers();
    const tool = waitTool();
    const args = {
      session_ids: ["00000000-0000-0006"],
    } as SubagentWaitParams;
    const context = renderContext(args);
    const call = tool.renderCall!(args, theme(), context);
    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);

    const completed = tool.renderResult!(
      {
        content: [{ type: "text", text: "{}" }],
        details: {
          reason: "completed",
          terminal: [{ session_id: "00000000-0000-0006", status: "completed" }],
          pending: [],
        },
      } as any,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    expect(rendered(completed)).toBe(
      "<success>✓</success> <toolTitle>Agent Wait</toolTitle><dim> · 1 sessions</dim>",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never shows success for an interrupted wait", () => {
    vi.useFakeTimers();
    const tool = waitTool();
    const args = {
      session_ids: ["00000000-0000-0006"],
    } as SubagentWaitParams;
    const context = renderContext(args);
    const call = tool.renderCall!(args, theme(), context);
    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);

    const interrupted = tool.renderResult!(
      {
        content: [{ type: "text", text: "{}" }],
        details: {
          reason: "interrupted",
          terminal: [],
          pending: [{ session_id: "00000000-0000-0006", status: "running" }],
        },
      } as any,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    const text = rendered(interrupted);
    expect(text).toContain("Agent Wait");
    expect(text).toContain("<warning>!</warning>");
    expect(text).not.toContain("✓");
    expect(text).not.toContain("<success>");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders failures with the x glyph and a visible reason", () => {
    vi.useFakeTimers();
    const tool = waitTool();
    const args = {
      session_ids: ["00000000-0000-0006"],
    } as SubagentWaitParams;
    const context = renderContext(args);
    const call = tool.renderCall!(args, theme(), context);
    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);

    const failure = tool.renderResult!(
      {
        content: [{ type: "text", text: "{}" }],
        details: {
          error: { code: "INTERNAL_ERROR", message: "wait broke" },
        },
      } as any,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    const lines = failure.render(200).join("\n");
    expect(lines).toContain("<error>x</error>");
    expect(lines).toContain("Agent Wait");
    expect(lines).toContain("<error>wait broke</error>");
    expect(lines).not.toContain("✓");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders nothing animated for replay/export", () => {
    vi.useFakeTimers();
    const tool = waitTool();
    const args = {
      session_ids: ["00000000-0000-0006"],
    } as SubagentWaitParams;
    const context = renderContext(args, "wait-export");
    context.executionStarted = true;
    expect(tool.renderCall!(args, theme(), context).render(200)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    const exported = tool.renderResult!(
      {
        content: [{ type: "text", text: "{}" }],
        details: {
          reason: "completed",
          terminal: [{ session_id: "00000000-0000-0006", status: "completed" }],
          pending: [],
        },
      } as any,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    expect(rendered(exported)).toContain("Agent Wait");
    expect(rendered(exported)).toContain("✓");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("executes the wait through the tool boundary", async () => {
    const terminal = {
      reason: "completed",
      terminal: [{ session_id: "00000000-0000-0006", status: "completed" }],
      pending: [],
    };
    const tool = createTools({
      sessions: {
        call: async () => ({}),
        output: async () => ({}),
        shutdown: async () => undefined,
        wait: async () => terminal,
      } as any,
    }).find((entry) => entry.name === "subagent_wait")!;
    const result = await tool.execute(
      "wait-exec",
      { session_ids: ["00000000-0000-0006"] },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    expect(result.details).toEqual(terminal);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(terminal) },
    ]);
  });
});

describe("spinner frames", () => {
  it("animates the Agents widget through exactly the nine required frames", () => {
    vi.useFakeTimers();
    try {
      const row: AgentViewRow = {
        session_id: "00000000-0000-0006",
        agent: "worker",
        label: "do work",
        elapsedMs: 0,
        phase: "working · turn 1",
        turns: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const fakeTheme = {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
        bold: (text: string) => text,
      } as Theme;
      let component: { render(): string[] } | undefined;
      const setWidget = vi.fn((_key: string, factory: unknown) => {
        if (typeof factory === "function") {
          component = (
            factory as (
              tui: { requestRender(): void },
              theme: Theme,
            ) => { render(): string[] }
          )({ requestRender: vi.fn() }, fakeTheme);
        }
      });
      const view = new AgentsView(
        { setWidget } as unknown as ExtensionContext["ui"],
        () => [row],
      );
      view.refresh();
      const seen: string[] = [];
      for (let tick = 0; tick < EXPECTED_FRAMES.length; tick += 1) {
        const line = component?.render()[1] ?? "";
        expect(line).toContain(`<accent>${EXPECTED_FRAMES[tick]}</accent>`);
        seen.push(line);
        vi.advanceTimersByTime(80);
      }
      // The tenth tick wraps back to the first frame: no trailing blank.
      expect(component?.render()[1]).toContain(
        `<accent>${EXPECTED_FRAMES[0]}</accent>`,
      );
      for (const line of seen) {
        expect(line).not.toContain("<accent> </accent>");
      }
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
