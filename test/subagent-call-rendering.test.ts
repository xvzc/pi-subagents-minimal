import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { MinimalSubagentsError } from "../src/errors.js";
import { createTools } from "../src/index.js";
import type { SubagentCallParams } from "../src/schemas.js";
import type { SessionCallLifecycle, ToolServices } from "../src/types.js";

function theme(): Theme {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => text,
  } as Theme;
}

function callTool(sessions: ToolServices["sessions"]): ToolDefinition {
  return createTools({ sessions }).find(
    (tool) => tool.name === "subagent_call",
  )!;
}

function renderContext(args: SubagentCallParams, toolCallId = "call") {
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

const unusedServices = {
  output: async () => ({}),
  shutdown: async () => undefined,
};

// The heading carries only agent and operation metadata; successful results
// append the observed session ID. Steer carries no execution mode label.
const pending = (agent: string, operation: "new" | "resume") =>
  `<accent>⠐</accent> <toolTitle>Agent Call</toolTitle><dim> · ${agent} · ${operation}</dim>`;
const accepted = (
  agent: string,
  operation: "new" | "resume",
  sessionId?: string,
) =>
  `<accent>❯</accent> <toolTitle>Agent Call</toolTitle><dim> · ${agent} · ${operation}${sessionId ? ` · ${sessionId}` : ""}</dim>`;
const pendingSteer = (agent?: string) =>
  agent
    ? `<accent>⠐</accent> <toolTitle>Agent Call</toolTitle><dim> · ${agent} · steer</dim>`
    : `<accent>⠐</accent> <toolTitle>Agent Call</toolTitle><dim> · steer</dim>`;
const acceptedSteer = (agent: string) =>
  `<accent>❯</accent> <toolTitle>Agent Call</toolTitle><dim> · ${agent} · steer</dim>`;
const failed = (agent: string, operation: "new" | "resume") =>
  `<error>x</error> <toolTitle>Agent Call</toolTitle><dim> · ${agent} · ${operation}</dim>`;
const failedSteer = (agent: string) =>
  `<error>x</error> <toolTitle>Agent Call</toolTitle><dim> · ${agent} · steer</dim>`;
afterEach(() => {
  vi.useRealTimers();
});

describe("subagent_call ToolCall rendering", () => {
  it("renders a background new call that settles to an accepted row with queued details", async () => {
    vi.useFakeTimers();
    const details = {
      status: "queued",
      agent: "reviewer",
      session_id: "00000000-0000-0004",
    };
    const tool = callTool({
      ...unusedServices,
      call: async () => details,
    });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args);
    const call = tool.renderCall!(args, theme(), context);

    expect(tool.renderShell).toBeUndefined();
    expect(rendered(call)).toBe(pending("reviewer", "new"));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(80);
    expect(rendered(call)).toContain("<accent>⠰</accent>");
    expect(context.invalidate).toHaveBeenCalledTimes(1);

    const updates: unknown[] = [];
    const final = await tool.execute(
      "call",
      args,
      undefined,
      (value) => {
        updates.push(value);
      },
      {} as ExtensionContext,
    );
    // Background new/resume never report identification via onUpdate.
    expect(updates).toEqual([]);
    expect(final).toEqual({
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
    });
    context.isPartial = false;
    context.lastComponent = call;
    expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
      accepted("reviewer", "new"),
    );
    expect(
      tool.renderResult!(
        final,
        { expanded: false, isPartial: false },
        theme(),
        context,
      ).render(200),
    ).toEqual([]);
    context.expanded = true;
    expect(rendered(tool.renderCall!(args, theme(), context))).toContain(
      "task",
    );
    expect(
      tool.renderResult!(
        final,
        { expanded: true, isPartial: false },
        theme(),
        context,
      ).render(200),
    ).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders a background resume call without an identification update", async () => {
    vi.useFakeTimers();
    let lifecycle: SessionCallLifecycle | undefined;
    const tool = callTool({
      ...unusedServices,
      call: async (_params, _context, value) => {
        lifecycle = value;
        return {
          status: "queued",
          agent: "reviewer",
          session_id: "00000000-0000-001b",
        };
      },
    });
    const args = {
      type: "resume",
      session_id: "00000000-0000-001b",
      prompt: "continue",
    } as SubagentCallParams;
    const context = renderContext(args, "resume");
    const call = tool.renderCall!(args, theme(), context);
    const updates: unknown[] = [];
    const result = await tool.execute(
      "resume",
      args,
      undefined,
      (update) => {
        updates.push(update);
        return tool.renderResult!(
          update,
          { expanded: false, isPartial: true },
          theme(),
          context,
        );
      },
      {} as ExtensionContext,
    );

    expect(lifecycle).toBeDefined();
    lifecycle!.identified("reviewer");
    // Background resume identification updates presentation metadata only.
    expect(updates).toEqual([]);
    expect(rendered(call)).toBe(
      "<accent>⠐</accent> <toolTitle>Agent Call</toolTitle><dim> · resume</dim>",
    );
    context.isPartial = false;
    context.lastComponent = call;
    const settled = tool.renderCall!(args, theme(), context);
    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    expect(rendered(settled)).toBe(
      accepted("reviewer", "resume", "00000000-0000-001b"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["new", { type: "new", agent: "reviewer", prompt: "task" }],
    [
      "resume",
      { type: "resume", session_id: "00000000-0000-001b", prompt: "continue" },
    ],
  ] as const)(
    "retains accepted background %s call without an immediate output",
    async (_operation, input) => {
      vi.useFakeTimers();
      const details = { status: "queued", agent: "reviewer" };
      const tool = callTool({
        ...unusedServices,
        call: async () => details,
      });
      const args = input as SubagentCallParams;
      const context = renderContext(args, `background-${args.type}`);
      const call = tool.renderCall!(args, theme(), context);
      expect(rendered(call)).toBe(
        args.type === "resume"
          ? "<accent>⠐</accent> <toolTitle>Agent Call</toolTitle><dim> · resume</dim>"
          : pending("reviewer", args.type as "new"),
      );
      const result = await tool.execute(
        "call",
        args,
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      context.isPartial = false;
      context.lastComponent = call;
      const settledCall = tool.renderCall!(args, theme(), context);
      const settledResult = tool.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme(),
        context,
      );
      expect(rendered(settledCall)).toBe(
        accepted("reviewer", args.type as "new" | "resume"),
      );
      expect(settledResult.render(200)).toEqual([]);
      context.expanded = true;
      expect(rendered(tool.renderCall!(args, theme(), context))).toContain(
        args.prompt,
      );
      expect(result.details).toBe(details);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("renders steer as an immediate control operation without a background label", async () => {
    vi.useFakeTimers();
    const details = {
      session_id: "00000000-0000-001b",
      status: "running",
      steered: true,
    };
    const tool = callTool({
      ...unusedServices,
      call: async (_params, _context, lifecycle) => {
        lifecycle?.identified("reviewer");
        return details;
      },
    });
    const args = {
      type: "steer",
      session_id: "00000000-0000-001b",
      prompt: "change course",
    } as SubagentCallParams;
    const context = renderContext(args, "steer");
    const call = tool.renderCall!(args, theme(), context);
    expect(rendered(call)).toBe(pendingSteer());
    const updates: AgentToolResult<unknown>[] = [];
    const result = await tool.execute(
      "steer",
      args,
      undefined,
      (update) => updates.push(update),
      {} as ExtensionContext,
    );
    tool.renderResult!(
      updates[0]!,
      { expanded: false, isPartial: true },
      theme(),
      context,
    );
    expect(rendered(call)).toBe(acceptedSteer("reviewer"));

    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);
    expect(details).toEqual({
      session_id: "00000000-0000-001b",
      status: "running",
      steered: true,
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(details) },
    ]);
    expect(result.details).toEqual({
      ...details,
      __pi_subagents_minimal_ui: { agent: "reviewer" },
    });
    expect(
      tool.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme(),
        context,
      ).render(200),
    ).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves steer identity in replay/export without transient partial state", async () => {
    vi.useFakeTimers();
    const serviceResult = {
      session_id: "00000000-0000-001b",
      status: "running",
      steered: true,
    };
    const tool = callTool({
      ...unusedServices,
      call: async (_params, _context, lifecycle) => {
        lifecycle?.identified("reviewer");
        return serviceResult;
      },
    });
    const args = {
      type: "steer",
      session_id: "00000000-0000-001b",
      prompt: "change course",
    } as SubagentCallParams;
    const result = await tool.execute(
      "steer-export",
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(serviceResult).toEqual({
      session_id: "00000000-0000-001b",
      status: "running",
      steered: true,
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(serviceResult) },
    ]);
    expect(result.details).toEqual({
      ...serviceResult,
      __pi_subagents_minimal_ui: { agent: "reviewer" },
    });

    const exporter = createToolHtmlRenderer({
      getToolDefinition: () => tool,
      theme: theme() as any,
      cwd: "/project",
      width: 200,
    });
    const exportedCall = exporter.renderCall(
      "steer-export",
      "subagent_call",
      args,
    );
    expect(exportedCall).toContain("Agent Call");
    expect(exportedCall).toContain("steer");
    expect(exportedCall).not.toContain("background");
    expect(exportedCall).not.toContain("reviewer");
    const exported = exporter.renderResult(
      "steer-export",
      "subagent_call",
      result.content,
      result.details,
      false,
    );
    expect(exported?.expanded).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders an accurate safe failure with the available agent identity", async () => {
    vi.useFakeTimers();
    const tool = callTool({
      ...unusedServices,
      call: async () => {
        throw new MinimalSubagentsError(
          "INTERNAL_ERROR",
          "setup failed\n\u001b[31maccurately",
        );
      },
    });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args, "failure");
    const call = tool.renderCall!(args, theme(), context);
    const updates: unknown[] = [];
    const result = await tool.execute(
      "failure",
      args,
      undefined,
      (update) => updates.push(update),
      {} as ExtensionContext,
    );
    expect(updates).toEqual([]);
    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);

    // The failure reason is always visible, even when collapsed; the heading
    // carries only glyph/title/metadata with no inline error suffix.
    const failure = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    const failureLines = failure.render(200);
    expect(failureLines).toHaveLength(1);
    expect(failureLines[0]?.startsWith("  ")).toBe(true);
    expect(failureLines[0]).toContain("<error>setup failed accurately</error>");
    expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
      failed("reviewer", "new"),
    );
    expect(result.details).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "setup failed\n\u001b[31maccurately",
      },
      __pi_subagents_minimal_ui: { agent: "reviewer" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "setup failed\n\u001b[31maccurately",
          },
        }),
      },
    ]);
    // Expanded keeps the prompt in the call row while the reason stays visible.
    context.expanded = true;
    expect(rendered(tool.renderCall!(args, theme(), context))).toContain(
      "task",
    );
    expect(
      tool.renderResult!(
        result,
        { expanded: true, isPartial: false },
        theme(),
        context,
      )
        .render(200)
        .join("\n"),
    ).toContain("<error>setup failed accurately</error>");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["MODEL_NOT_FOUND", "new"],
    ["THINKING_LEVEL_UNSUPPORTED", "new"],
    ["INVALID_ARGUMENT", "resume"],
    ["SESSION_NOT_FOUND", "steer"],
  ] as const)(
    "renders a pre-queue %s failure with the x glyph",
    async (code, kind) => {
      vi.useFakeTimers();
      const tool = callTool({
        ...unusedServices,
        call: async (_params, _context, lifecycle) => {
          if (kind !== "resume") lifecycle?.identified("reviewer");
          throw new MinimalSubagentsError(code as any, `${code} happened`);
        },
      });
      const args =
        kind === "new"
          ? ({
              type: "new",
              agent: "reviewer",
              prompt: "task",
            } as SubagentCallParams)
          : kind === "resume"
            ? ({
                type: "resume",
                session_id: "00000000-0000-001b",
                prompt: "continue",
              } as SubagentCallParams)
            : ({
                type: "steer",
                session_id: "00000000-0000-001b",
                prompt: "change course",
              } as SubagentCallParams);
      const context = renderContext(args, `pre-queue-${code}`);
      const call = tool.renderCall!(args, theme(), context);
      const result = await tool.execute(
        "call",
        args,
        undefined,
        () => {},
        {} as ExtensionContext,
      );
      expect(result.details).toMatchObject({ error: { code } });

      context.isPartial = false;
      context.lastComponent = call;
      tool.renderCall!(args, theme(), context);
      const failureBody = tool.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme(),
        context,
      );
      expect(failureBody.render(200).join("\n")).toContain(`${code} happened`);
      const settled = tool.renderCall!(args, theme(), context);
      if (kind === "steer") {
        expect(rendered(settled)).toBe(failedSteer("reviewer"));
      } else if (kind === "new") {
        expect(rendered(settled)).toBe(failed("reviewer", "new"));
      } else {
        expect(rendered(settled)).toContain("<error>x</error>");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps an accepted Agent Call after a later background child failure", async () => {
    vi.useFakeTimers();
    const queued = {
      status: "queued",
      agent: "reviewer",
      session_id: "00000000-0000-0004",
    };
    const tool = callTool({ ...unusedServices, call: async () => queued });
    const outputTool = createTools({
      sessions: {
        call: async () => queued,
        output: async () => ({
          agent: "reviewer",
          status: "failed",
          error: "child failed",
        }),
        shutdown: async () => undefined,
      },
    }).find((entry) => entry.name === "subagent_output")!;
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args, "queued-then-failed");
    const call = tool.renderCall!(args, theme(), context);
    const result = await tool.execute(
      "call",
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);
    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
      accepted("reviewer", "new", "00000000-0000-0004"),
    );

    const output = outputTool.renderResult!(
      {
        content: [],
        details: { agent: "reviewer", status: "failed", error: "child failed" },
      } as any,
      { expanded: false, isPartial: false } as any,
      theme(),
      {} as any,
    );
    const outputText = output.render(200).join("\n");
    expect(outputText).toContain("<error>x</error>");
    expect(outputText).not.toContain("· child failed");
    expect(outputText).toContain("<error>child failed</error>");
    expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
      accepted("reviewer", "new", "00000000-0000-0004"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replays a settled failure deterministically through the interactive host", async () => {
    vi.useFakeTimers();
    initTheme(undefined, false);
    const tool = callTool({
      ...unusedServices,
      call: async () => {
        throw new MinimalSubagentsError("MODEL_NOT_FOUND", "missing model");
      },
    });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const requestRender = vi.fn();
    const host = new ToolExecutionComponent(
      "subagent_call",
      "replay-failure",
      args,
      {},
      tool,
      { requestRender } as any,
      "/project",
    );
    host.markExecutionStarted();
    const result = await tool.execute(
      "replay-failure",
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    host.updateResult(result as any, false);
    expect(
      stripTerminalSequences(host.render(200).join("\n"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual(["x Agent Call · reviewer · new", "missing model"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes and caps the call failure reason", async () => {
    vi.useFakeTimers();
    const tool = callTool({
      ...unusedServices,
      call: async () => {
        throw new MinimalSubagentsError(
          "INVALID_ARGUMENT",
          `bad\n\u001b[31mthing${"z".repeat(200)}`,
        );
      },
    });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args, "sanitized-failure");
    const call = tool.renderCall!(args, theme(), context);
    const result = await tool.execute(
      "call",
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    context.isPartial = false;
    context.lastComponent = call;
    const body = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme(),
      context,
    )
      .render(200)
      .join("\n");
    expect(body).not.toContain("\u001b");
    expect(body).toContain("bad thing");
    expect(body).toContain("…");
    expect(body).not.toContain("z".repeat(200));
    expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
      failed("reviewer", "new"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows the prompt and failure reason together when expanded", async () => {
    vi.useFakeTimers();
    initTheme(undefined, false);
    const tool = callTool({
      ...unusedServices,
      call: async () => {
        throw new MinimalSubagentsError("MODEL_NOT_FOUND", "missing model");
      },
    });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const host = new ToolExecutionComponent(
      "subagent_call",
      "expanded-failure",
      args,
      {},
      tool,
      { requestRender: vi.fn() } as any,
      "/project",
    );
    host.markExecutionStarted();
    const result = await tool.execute(
      "expanded-failure",
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    host.updateResult(result as any, false);
    host.setExpanded(true);
    const lines = stripTerminalSequences(host.render(200).join("\n"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines[0]).toBe("x Agent Call · reviewer · new");
    expect(lines).toContain("task");
    expect(lines).toContain("missing model");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exports the call failure reason in the result section", async () => {
    vi.useFakeTimers();
    const tool = callTool({
      ...unusedServices,
      call: async () => {
        throw new MinimalSubagentsError("MODEL_NOT_FOUND", "missing model");
      },
    });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const result = await tool.execute(
      "export-failure",
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const exporter = createToolHtmlRenderer({
      getToolDefinition: () => tool,
      theme: theme() as any,
      cwd: "/project",
      width: 200,
    });
    // The standalone exporter snapshots the call header before the result is
    // known (renderCall receives no error context), so the failure glyph and
    // reason are carried by the result section, not the call header.
    const exportedCall = exporter.renderCall(
      "export-failure",
      "subagent_call",
      args,
    );
    expect(exportedCall).toContain("Agent Call");
    const exported = exporter.renderResult(
      "export-failure",
      "subagent_call",
      result.content,
      result.details,
      false,
    );
    expect(exported?.expanded).toContain("missing model");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses one component and cleans its timer on partial rerender and settlement", () => {
    vi.useFakeTimers();
    const tool = callTool({ ...unusedServices, call: async () => ({}) });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args, "reuse");
    const first = tool.renderCall!(args, theme(), context);
    expect(vi.getTimerCount()).toBe(1);

    context.executionStarted = true;
    context.lastComponent = first;
    const reused = tool.renderCall!(args, theme(), context);
    expect(reused).toBe(first);
    expect(vi.getTimerCount()).toBe(1);

    context.isPartial = false;
    const settled = tool.renderCall!(args, theme(), context);
    expect(rendered(settled)).toBe(accepted("reviewer", "new"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates HTML export from an in-flight spinner with the same tool call ID", () => {
    vi.useFakeTimers();
    const tool = callTool({ ...unusedServices, call: async () => ({}) });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args, "shared-id");
    const live = tool.renderCall!(args, theme(), context);
    expect(vi.getTimerCount()).toBe(1);

    const exporter = createToolHtmlRenderer({
      getToolDefinition: () => tool,
      theme: theme() as any,
      cwd: "/project",
      width: 200,
    });
    expect(exporter.renderCall("shared-id", "subagent_call", args)).toContain(
      "Agent Call",
    );
    expect(
      exporter.renderResult(
        "shared-id",
        "subagent_call",
        [{ type: "text", text: '{"status":"completed","agent":"reviewer"}' }],
        { status: "completed", agent: "reviewer" },
        false,
      )?.expanded,
    ).toBe("");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(80);
    expect(rendered(live)).toContain("<accent>⠰</accent>");
    expect(context.invalidate).toHaveBeenCalledExactlyOnceWith();

    context.isPartial = false;
    context.lastComponent = live;
    tool.renderCall!(args, theme(), context);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart a spinner after invalidation throws", () => {
    vi.useFakeTimers();
    const tool = callTool({ ...unusedServices, call: async () => ({}) });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args, "invalidate-failure");
    context.invalidate = vi.fn(() => {
      throw new Error("render failed");
    });
    const call = tool.renderCall!(args, theme(), context);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(80);
    expect(context.invalidate).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);

    context.executionStarted = true;
    context.lastComponent = call;
    expect(tool.renderCall!(args, theme(), context)).toBe(call);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconstructs an interactive settled call before its result without a visible pending frame", () => {
    vi.useFakeTimers();
    initTheme(undefined, false);
    const tool = callTool({ ...unusedServices, call: async () => ({}) });
    const args = {
      type: "resume",
      session_id: "00000000-0000-001b",
      prompt: "continue",
    } as SubagentCallParams;
    const requestRender = vi.fn();
    const host = new ToolExecutionComponent(
      "subagent_call",
      "reconstructed",
      args,
      {},
      tool,
      { requestRender } as any,
      "/project",
    );

    // The host constructor exposes no replay discriminator, so it allocates a
    // transient timer before synchronously applying the persisted result.
    expect(vi.getTimerCount()).toBe(1);
    host.markExecutionStarted();
    host.updateResult(
      {
        content: [
          {
            type: "text",
            text: '{"status":"completed","agent":"reviewer","output":"done"}',
          },
        ],
        details: { status: "completed", agent: "reviewer", output: "done" },
        isError: false,
      },
      false,
    );

    expect(vi.getTimerCount()).toBe(0);
    expect(
      stripTerminalSequences(host.render(200).join("\n"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual(["❯ Agent Call · reviewer · resume"]);
    vi.advanceTimersByTime(80);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses default host composition with only the retained call row", () => {
    vi.useFakeTimers();
    initTheme(undefined, false);
    const tool = callTool({ ...unusedServices, call: async () => ({}) });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const host = new ToolExecutionComponent(
      "subagent_call",
      "host-call",
      args,
      {},
      tool,
      { requestRender: vi.fn() } as any,
      "/project",
    );
    expect(host.render(200).join("\n")).toContain("Agent Call");
    expect(vi.getTimerCount()).toBe(1);

    host.markExecutionStarted();
    host.updateResult(
      {
        content: [
          { type: "text", text: '{"status":"completed","agent":"reviewer"}' },
        ],
        details: { status: "completed", agent: "reviewer" },
        isError: false,
      },
      false,
    );
    const settled = host.render(200).join("\n");
    expect(settled).not.toContain("Agent Output");
    expect(settled).toContain("reviewer");
    expect(settled).toContain("Agent Call");
    expect(
      stripTerminalSequences(settled)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual(["❯ Agent Call · reviewer · new"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is replay/export safe and omits the separate custom entry from HTML tool rendering", () => {
    vi.useFakeTimers();
    const tool = callTool({ ...unusedServices, call: async () => ({}) });
    const args = {
      type: "resume",
      session_id: "00000000-0000-001b",
      prompt: "continue",
    } as SubagentCallParams;
    const replayContext = renderContext(args, "replay");
    replayContext.executionStarted = true;
    expect(rendered(tool.renderCall!(args, theme(), replayContext))).toBe(
      "<accent>❯</accent> <toolTitle>Agent Call</toolTitle><dim> · resume</dim>",
    );
    expect(vi.getTimerCount()).toBe(0);

    const exporter = createToolHtmlRenderer({
      getToolDefinition: () => tool,
      theme: theme() as any,
      cwd: "/project",
      width: 200,
    });
    const exportedCall = exporter.renderCall("export", "subagent_call", args);
    expect(exportedCall).toContain("Agent Call");
    expect(exportedCall).toContain("resume");
    expect(exportedCall).not.toContain("reviewer");
    const result = exporter.renderResult(
      "export",
      "subagent_call",
      [{ type: "text", text: '{"status":"completed","agent":"reviewer"}' }],
      { status: "completed", agent: "reviewer" },
      false,
    );
    expect(result?.expanded).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("subagent_call session ID heading", () => {
  it("appends the observed session ID after a successful new call", async () => {
    vi.useFakeTimers();
    const details = {
      status: "queued",
      agent: "reviewer",
      session_id: "00000000-0000-0008",
    };
    const tool = callTool({ ...unusedServices, call: async () => details });
    const args = {
      type: "new",
      agent: "reviewer",
      prompt: "task",
    } as SubagentCallParams;
    const context = renderContext(args, "session-id");
    const call = tool.renderCall!(args, theme(), context);
    expect(rendered(call)).toBe(pending("reviewer", "new"));

    const result = await tool.execute(
      "session-id",
      args,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);
    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
      accepted("reviewer", "new", "00000000-0000-0008"),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("appends the observed session ID after a successful steer", async () => {
    vi.useFakeTimers();
    const tool = callTool({
      ...unusedServices,
      call: async (_params, _context, lifecycle) => {
        lifecycle?.identified("reviewer");
        return {
          session_id: "00000000-0000-0066",
          status: "running",
          steered: true,
        };
      },
    });
    const args = {
      type: "steer",
      session_id: "00000000-0000-0066",
      prompt: "change course",
    } as SubagentCallParams;
    const context = renderContext(args, "steer-session");
    const call = tool.renderCall!(args, theme(), context);
    const updates: AgentToolResult<unknown>[] = [];
    const result = await tool.execute(
      "steer-session",
      args,
      undefined,
      (update) => updates.push(update),
      {} as ExtensionContext,
    );
    tool.renderResult!(
      updates[0]!,
      { expanded: false, isPartial: true },
      theme(),
      context,
    );
    context.isPartial = false;
    context.lastComponent = call;
    tool.renderCall!(args, theme(), context);
    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme(),
      context,
    );
    expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
      "<accent>❯</accent> <toolTitle>Agent Call</toolTitle><dim> · reviewer · steer · 00000000-0000-0066</dim>",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows no session ID without an observed valid ID", async () => {
    vi.useFakeTimers();
    for (const [id, details] of [
      ["missing-id", { status: "queued", agent: "reviewer" }],
      [
        "foreign-id",
        { status: "queued", agent: "reviewer", session_id: "abc" },
      ],
    ] as const) {
      const tool = callTool({ ...unusedServices, call: async () => details });
      const args = {
        type: "new",
        agent: "reviewer",
        prompt: "task",
      } as SubagentCallParams;
      const context = renderContext(args, id);
      const call = tool.renderCall!(args, theme(), context);
      const result = await tool.execute(
        id,
        args,
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      context.isPartial = false;
      context.lastComponent = call;
      tool.renderCall!(args, theme(), context);
      tool.renderResult!(
        result,
        { expanded: false, isPartial: false },
        theme(),
        context,
      );
      expect(rendered(tool.renderCall!(args, theme(), context))).toBe(
        accepted("reviewer", "new"),
      );
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
