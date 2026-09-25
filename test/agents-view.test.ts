import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  AgentsView,
  type AgentViewRow,
  deriveLabel,
  derivePhase,
  formatElapsed,
  renderAgents,
} from "../src/runtime/agents-view.js";

const row: AgentViewRow = {
  session_id: "00000000-0000-0006",
  agent: "worker",
  label: "do work",
  elapsedMs: 65_000,
  phase: "working · turn 1",
  turns: 1,
  inputTokens: 2800,
  outputTokens: 4100,
  model: "test/model",
  thinking: "medium",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as Theme;

describe("Agents view", () => {
  it("derives labels, phases, and elapsed text", () => {
    expect(deriveLabel("\n  many   words here\nignored")).toBe(
      "many words here",
    );
    expect(deriveLabel("x".repeat(61))).toBe(`${"x".repeat(59)}…`);
    expect(derivePhase("queued", 2)).toBe("queued (position 2)");
    expect(derivePhase("running", undefined)).toBe("starting");
    expect(derivePhase("running", undefined, 2, 3)).toBe(
      "working · turn 2 · 3 tools",
    );
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(40)).toBe("0.0s");
    expect(formatElapsed(-1000)).toBe("0.0s");
    expect(formatElapsed(5000)).toBe("5.0s");
    expect(formatElapsed(17_340)).toBe("17.3s");
    expect(formatElapsed(59_900)).toBe("59.9s");
    expect(formatElapsed(59_999)).toBe("60.0s");
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(67_000)).toBe("1m 07s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatElapsed(3_599_000)).toBe("59m 59s");
    expect(formatElapsed(3_600_000)).toBe("1h 00m 00s");
    expect(formatElapsed(3_667_000)).toBe("1h 01m 07s");
    expect(formatElapsed(86_400_000)).toBe("1d 00h 00m 00s");
    expect(formatElapsed(90_067_000)).toBe("1d 01h 01m 07s");
  });

  it("renders exact semantic output with queue-first rows and a final tree branch", () => {
    expect(
      renderAgents([
        row,
        {
          ...row,
          session_id: "00000000-0000-0043",
          label: "queued",
          queuePosition: 1,
          phase: "queued (position 1)",
        },
      ]),
    ).toEqual([
      "❯ Agents · 2 working · 0 finished",
      "├─ ⠐ worker · queued · 1m 05s",
      "│    ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
      "└─ ⠐ worker · do work · 1m 05s",
      "     ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
    ]);
    expect(
      renderAgents([
        { ...row, turns: 0, inputTokens: undefined, outputTokens: undefined },
      ]),
    ).toEqual([
      "❯ Agents · 1 working · 0 finished",
      "└─ ⠐ worker · do work · 1m 05s",
      "     ▪ test/model · medium · 0 turns ·    — in /    — out",
    ]);
  });

  it("renders stats in model, thinking, turns, tokens order", () => {
    const lines = renderAgents([row]);
    expect(lines[2]).toBe(
      "     ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
    );
    const missing = renderAgents([
      { ...row, model: undefined, thinking: undefined },
    ]);
    expect(missing[2]).toBe("     ▪ — · — · 1 turns · 2.8k in / 4.1k out");
  });

  it("always renders the literal labels working and finished, including count 1", () => {
    const header = renderAgents([{ ...row, turns: 1 }])[0];
    expect(header).toBe("❯ Agents · 1 working · 0 finished");
  });

  it("renders an all-finished set with only the finished count", () => {
    expect(
      renderAgents([
        {
          ...row,
          session_id: "00000000-0000-0017",
          phase: "completed",
          terminalStatus: "completed",
        },
        {
          ...row,
          session_id: "00000000-0000-000f",
          phase: "failed",
          terminalStatus: "failed",
        },
      ])[0],
    ).toBe("❯ Agents · 0 working · 2 finished");
  });

  it("recomputes the working/finished counts from the current rows on every render", () => {
    const working: AgentViewRow = {
      ...row,
      session_id: "00000000-0000-0060",
      label: "active",
    };
    const done: AgentViewRow = {
      ...row,
      session_id: "00000000-0000-0014",
      label: "finished",
      phase: "completed",
      terminalStatus: "completed",
    };
    expect(renderAgents([working])[0]).toBe(
      "❯ Agents · 1 working · 0 finished",
    );
    expect(renderAgents([working, done])[0]).toBe(
      "❯ Agents · 1 working · 1 finished",
    );
    expect(renderAgents([done])[0]).toBe("❯ Agents · 0 working · 1 finished");
    expect(renderAgents([working, working, done, done])[0]).toBe(
      "❯ Agents · 2 working · 2 finished",
    );
  });

  it("renders lingering terminal rows with static outcome markers instead of spinners", () => {
    expect(
      renderAgents([
        {
          ...row,
          session_id: "00000000-0000-0043",
          label: "queued",
          queuePosition: 1,
          phase: "queued (position 1)",
        },
        {
          ...row,
          session_id: "00000000-0000-000a",
          label: "killed",
          phase: "aborted",
          terminalStatus: "aborted",
        },
        {
          ...row,
          session_id: "00000000-0000-000f",
          label: "broken",
          phase: "failed",
          terminalStatus: "failed",
        },
        {
          ...row,
          session_id: "00000000-0000-0017",
          label: "finished",
          phase: "completed",
          terminalStatus: "completed",
        },
        {
          ...row,
          session_id: "00000000-0000-0056",
          label: "limited",
          phase: "stopped",
          terminalStatus: "stopped",
        },
      ]),
    ).toEqual([
      "❯ Agents · 1 working · 4 finished",
      "├─ ⠐ worker · queued · 1m 05s",
      "│    ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
      "├─ ■ worker · killed · 1m 05s",
      "│    ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
      "├─ ✕ worker · broken · 1m 05s",
      "│    ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
      "├─ ✓ worker · finished · 1m 05s",
      "│    ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
      "└─ ■ worker · limited · 1m 05s",
      "     ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
    ]);
  });

  it("themes terminal rows with outcome cues that never animate", () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      let component: { render(): string[] } | undefined;
      const setWidget = vi.fn((_key: string, factory: unknown) => {
        if (typeof factory === "function") {
          component = (
            factory as (
              tui: { requestRender(): void },
              theme: Theme,
            ) => { render(): string[] }
          )({ requestRender }, fakeTheme);
        }
      });
      const view = new AgentsView(
        { setWidget } as unknown as ExtensionContext["ui"],
        () => [
          row,
          {
            ...row,
            session_id: "00000000-0000-0017",
            label: "finished",
            phase: "completed",
            terminalStatus: "completed",
          },
          {
            ...row,
            session_id: "00000000-0000-000f",
            label: "broken",
            phase: "failed",
            terminalStatus: "failed",
          },
          {
            ...row,
            session_id: "00000000-0000-0056",
            label: "limited",
            phase: "stopped",
            terminalStatus: "stopped",
          },
          {
            ...row,
            session_id: "00000000-0000-000a",
            label: "killed",
            phase: "aborted",
            terminalStatus: "aborted",
          },
        ],
      );
      view.refresh();
      const before = component?.render() ?? [];
      expect(before[1]).toContain("<accent>⠐</accent>");
      expect(before).toContain(
        "<muted>├─ </muted><success>✓</success><text> worker</text><dim> · finished · 1m 05s</dim>",
      );
      expect(before).toContain(
        "<muted>├─ </muted><error>✕</error><text> worker</text><dim> · broken · 1m 05s</dim>",
      );
      expect(before).toContain(
        "<muted>├─ </muted><dim>■</dim><text> worker</text><dim> · killed · 1m 05s</dim>",
      );
      expect(before).toContain(
        "<muted>└─ </muted><warning>■</warning><text> worker</text><dim> · limited · 1m 05s</dim>",
      );
      vi.advanceTimersByTime(80);
      const after = component?.render() ?? [];
      expect(after[1]).toContain("<accent>⠰</accent>");
      expect(after.slice(2)).toEqual(before.slice(2));
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the supplied public theme for widget content", () => {
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
    expect(component?.render()).toEqual([
      "<accent>❯ </accent><accent><bold>Agents</bold></accent><dim> · </dim><dim>1 working</dim><dim> · </dim><dim>0 finished</dim>",
      "<muted>└─ </muted><accent>⠐</accent><text> worker</text><dim> · do work · 1m 05s</dim>",
      "<muted>     </muted><dim>▪ test/model · medium · 1 turns · 2.8k in / 4.1k out</dim>",
    ]);
    view.dispose();
  });

  it("right-aligns turn, input, and output columns across mixed widths", () => {
    const mixed: AgentViewRow[] = [
      {
        ...row,
        session_id: "00000000-0000-0002",
        turns: 7,
        inputTokens: 9500,
        outputTokens: 1200,
      },
      {
        ...row,
        session_id: "00000000-0000-0003",
        turns: 9,
        inputTokens: 12600,
        outputTokens: 87000,
      },
      {
        ...row,
        session_id: "00000000-0000-0005",
        turns: 12,
        inputTokens: 103200,
        outputTokens: 8700,
      },
    ];
    expect(renderAgents(mixed)).toEqual([
      "❯ Agents · 3 working · 0 finished",
      "├─ ⠐ worker · do work · 1m 05s",
      "│    ▪ test/model · medium ·  7 turns ·   9.5k in /  1.2k out",
      "├─ ⠐ worker · do work · 1m 05s",
      "│    ▪ test/model · medium ·  9 turns ·  12.6k in / 87.0k out",
      "└─ ⠐ worker · do work · 1m 05s",
      "     ▪ test/model · medium · 12 turns · 103.2k in /  8.7k out",
    ]);
  });

  it("formats every token example with exactly one decimal", () => {
    const cases: Array<[number, string]> = [
      [0, "0.0k"],
      [1, "0.0k"],
      [999, "1.0k"],
      [1000, "1.0k"],
      [9500, "9.5k"],
      [12000, "12.0k"],
      [18000, "18.0k"],
      [103200, "103.2k"],
      [999949, "999.9k"],
      [1000000, "1.0M"],
      [2000000, "2.0M"],
      [2837783, "2.8M"],
      [1000000000, "1.0B"],
      [1250000000, "1.3B"],
    ];
    for (const [raw, expected] of cases) {
      const lines = renderAgents([
        { ...row, turns: 7, inputTokens: raw, outputTokens: raw },
      ]);
      expect(lines[2]).toBe(
        `     ▪ test/model · medium · 7 turns · ${expected} in / ${expected} out`,
      );
    }
  });

  it("uses the same helper for input and output tokens", () => {
    const lines = renderAgents([
      { ...row, turns: 7, inputTokens: 2837783, outputTokens: 11000 },
    ]);
    expect(lines[2]).toBe(
      "     ▪ test/model · medium · 7 turns · 2.8M in / 11.0k out",
    );
    const swapped = renderAgents([
      { ...row, turns: 7, inputTokens: 11000, outputTokens: 2837783 },
    ]);
    expect(swapped[2]).toBe(
      "     ▪ test/model · medium · 7 turns · 11.0k in / 2.8M out",
    );
  });

  it("transitions k to M to B at the specified boundaries", () => {
    const statsFor = (tokens: number) =>
      renderAgents([
        { ...row, turns: 7, inputTokens: tokens, outputTokens: tokens },
      ])[2];
    expect(statsFor(999949)).toBe(
      "     ▪ test/model · medium · 7 turns · 999.9k in / 999.9k out",
    );
    expect(statsFor(1000000)).toBe(
      "     ▪ test/model · medium · 7 turns · 1.0M in / 1.0M out",
    );
    expect(statsFor(999999999)).toBe(
      "     ▪ test/model · medium · 7 turns · 1000.0M in / 1000.0M out",
    );
    expect(statsFor(1000000000)).toBe(
      "     ▪ test/model · medium · 7 turns · 1.0B in / 1.0B out",
    );
  });

  it("aligns mixed 4/7/12 turns with independent widths", () => {
    const mixed: AgentViewRow[] = [
      {
        ...row,
        session_id: "00000000-0000-0001",
        turns: 4,
        inputTokens: 9500,
        outputTokens: 1200,
      },
      {
        ...row,
        session_id: "00000000-0000-0002",
        turns: 7,
        inputTokens: 9500,
        outputTokens: 1200,
      },
      {
        ...row,
        session_id: "00000000-0000-0005",
        turns: 12,
        inputTokens: 9500,
        outputTokens: 1200,
      },
    ];
    expect(renderAgents(mixed)).toEqual([
      "❯ Agents · 3 working · 0 finished",
      "├─ ⠐ worker · do work · 1m 05s",
      "│    ▪ test/model · medium ·  4 turns · 9.5k in / 1.2k out",
      "├─ ⠐ worker · do work · 1m 05s",
      "│    ▪ test/model · medium ·  7 turns · 9.5k in / 1.2k out",
      "└─ ⠐ worker · do work · 1m 05s",
      "     ▪ test/model · medium · 12 turns · 9.5k in / 1.2k out",
    ]);
  });

  it("aligns input and output columns independently", () => {
    const mixed: AgentViewRow[] = [
      {
        ...row,
        session_id: "00000000-0000-0002",
        turns: 7,
        inputTokens: 9500,
        outputTokens: 1200,
      },
      {
        ...row,
        session_id: "00000000-0000-0003",
        turns: 9,
        inputTokens: 2837783,
        outputTokens: 11000,
      },
      {
        ...row,
        session_id: "00000000-0000-0005",
        turns: 12,
        inputTokens: 103200,
        outputTokens: 8700,
      },
    ];
    expect(renderAgents(mixed)).toEqual([
      "❯ Agents · 3 working · 0 finished",
      "├─ ⠐ worker · do work · 1m 05s",
      "│    ▪ test/model · medium ·  7 turns ·   9.5k in /  1.2k out",
      "├─ ⠐ worker · do work · 1m 05s",
      "│    ▪ test/model · medium ·  9 turns ·   2.8M in / 11.0k out",
      "└─ ⠐ worker · do work · 1m 05s",
      "     ▪ test/model · medium · 12 turns · 103.2k in /  8.7k out",
    ]);
  });

  it("keeps themed and plain widget rows visually identical", () => {
    const mixed: AgentViewRow[] = [
      {
        ...row,
        session_id: "00000000-0000-0002",
        turns: 7,
        inputTokens: 9500,
        outputTokens: 1200,
      },
      {
        ...row,
        session_id: "00000000-0000-0003",
        turns: 9,
        inputTokens: 2837783,
        outputTokens: 11000,
      },
      {
        ...row,
        session_id: "00000000-0000-0005",
        turns: 12,
        inputTokens: 103200,
        outputTokens: 8700,
      },
    ];
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
      () => mixed,
    );
    view.refresh();
    const themed = component?.render() ?? [];
    const plain = renderAgents(mixed);
    const strip = (text: string) => text.replace(/<[^>]+>/g, "");
    expect(themed.map(strip)).toEqual(plain);
    view.dispose();
  });

  it("keeps minimum column widths so a single small row does not collapse", () => {
    // Minimums: turns 7 ("7 turns"), tokens 4 ("9.5k"). Pinned here.
    expect(renderAgents([row])).toEqual([
      "❯ Agents · 1 working · 0 finished",
      "└─ ⠐ worker · do work · 1m 05s",
      "     ▪ test/model · medium · 1 turns · 2.8k in / 4.1k out",
    ]);
    expect(
      renderAgents([
        { ...row, turns: 0, inputTokens: undefined, outputTokens: undefined },
      ]),
    ).toEqual([
      "❯ Agents · 1 working · 0 finished",
      "└─ ⠐ worker · do work · 1m 05s",
      "     ▪ test/model · medium · 0 turns ·    — in /    — out",
    ]);
  });

  it("recomputes column widths when rendered rows grow and shrink", () => {
    const small: AgentViewRow = {
      ...row,
      session_id: "00000000-0000-0006",
      turns: 7,
      inputTokens: 9500,
      outputTokens: 1200,
    };
    const large: AgentViewRow = {
      ...row,
      session_id: "00000000-0000-000e",
      turns: 12,
      inputTokens: 103200,
      outputTokens: 103200,
    };
    const smallOnly = renderAgents([small]);
    expect(smallOnly[2]).toBe(
      "     ▪ test/model · medium · 7 turns · 9.5k in / 1.2k out",
    );
    const grown = renderAgents([small, large]);
    expect(grown[2]).toBe(
      "│    ▪ test/model · medium ·  7 turns ·   9.5k in /   1.2k out",
    );
    expect(grown[4]).toBe(
      "     ▪ test/model · medium · 12 turns · 103.2k in / 103.2k out",
    );
    const shrunk = renderAgents([small]);
    expect(shrunk).toEqual(smallOnly);
  });

  it("realigns themed widget rows through the AgentsView render lifecycle", () => {
    let rows: AgentViewRow[] = [
      {
        ...row,
        session_id: "00000000-0000-0006",
        turns: 7,
        inputTokens: 9500,
        outputTokens: 1200,
      },
    ];
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
      () => rows,
    );
    view.refresh();
    expect(component?.render()[2]).toBe(
      "<muted>     </muted><dim>▪ test/model · medium · 7 turns · 9.5k in / 1.2k out</dim>",
    );
    rows = [
      rows[0],
      {
        ...row,
        session_id: "00000000-0000-000e",
        turns: 12,
        inputTokens: 103200,
        outputTokens: 8700,
      },
    ];
    view.refresh();
    const grown = component?.render() ?? [];
    expect(grown[2]).toBe(
      "<muted>│    </muted><dim>▪ test/model · medium ·  7 turns ·   9.5k in / 1.2k out</dim>",
    );
    expect(grown[4]).toBe(
      "<muted>     </muted><dim>▪ test/model · medium · 12 turns · 103.2k in / 8.7k out</dim>",
    );
    rows = [rows[0]];
    view.refresh();
    expect(component?.render()[2]).toBe(
      "<muted>     </muted><dim>▪ test/model · medium · 7 turns · 9.5k in / 1.2k out</dim>",
    );
    view.dispose();
  });

  it("returns the snapshot it rendered so callers share one consistent read", () => {
    expect(new AgentsView(undefined, () => [row]).refresh()).toEqual([row]);
    expect(new AgentsView(undefined, () => []).refresh()).toEqual([]);
  });

  it("mounts, requests renders, and clears when idle", () => {
    let rows = [row];
    const requestRender = vi.fn();
    const setWidget = vi.fn((_key: string, factory: unknown) => {
      if (typeof factory === "function") {
        (factory as (tui: { requestRender(): void }, theme: Theme) => unknown)(
          { requestRender },
          fakeTheme,
        );
      }
    });
    const view = new AgentsView(
      { setWidget } as unknown as ExtensionContext["ui"],
      () => rows,
    );
    view.refresh();
    expect(setWidget).toHaveBeenCalledWith(
      "pi-subagents-minimal:agents",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    expect(requestRender).toHaveBeenCalledOnce();
    rows = [];
    view.refresh();
    expect(setWidget).toHaveBeenLastCalledWith(
      "pi-subagents-minimal:agents",
      undefined,
    );
  });

  it("animates without recomputing rows and clears both timers on disposal", () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const getRows = vi.fn(() => [row]);
      let component: { render(): string[] } | undefined;
      const setWidget = vi.fn((_key: string, factory: unknown) => {
        if (typeof factory === "function") {
          component = (
            factory as (
              tui: { requestRender(): void },
              theme: Theme,
            ) => { render(): string[] }
          )({ requestRender }, fakeTheme);
        }
      });
      const view = new AgentsView(
        { setWidget } as unknown as ExtensionContext["ui"],
        getRows,
      );
      view.refresh();
      expect(component?.render()[1]).toContain("<accent>⠐</accent>");
      vi.advanceTimersByTime(80);
      expect(component?.render()[1]).toContain("<accent>⠰</accent>");
      expect(requestRender).toHaveBeenCalledTimes(2);
      expect(getRows).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(4920);
      expect(getRows).toHaveBeenCalledTimes(2);
      const rendersAtDispose = requestRender.mock.calls.length;
      view.dispose();
      vi.advanceTimersByTime(5000);
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(getRows).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns once without throwing when spinner render requests fail", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    try {
      const requestRender = vi.fn(() => {
        throw new Error("requestRender secret");
      });
      const setWidget = vi.fn((_key: string, factory: unknown) => {
        if (typeof factory === "function") {
          (
            factory as (tui: { requestRender(): void }, theme: Theme) => unknown
          )({ requestRender }, fakeTheme);
        }
      });
      const view = new AgentsView(
        { setWidget, notify } as unknown as ExtensionContext["ui"],
        () => [row],
      );

      expect(() => view.refresh()).not.toThrow();
      expect(() => vi.advanceTimersByTime(240)).not.toThrow();
      expect(requestRender).toHaveBeenCalledTimes(4);
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "[pi-subagents-minimal] Could not refresh the Agents view.",
        "warning",
      );
      expect(JSON.stringify(notify.mock.calls)).not.toContain("secret");

      const attemptsAtDispose = requestRender.mock.calls.length;
      const warningsAtDispose = notify.mock.calls.length;
      view.dispose();
      vi.advanceTimersByTime(5000);
      expect(requestRender).toHaveBeenCalledTimes(attemptsAtDispose);
      expect(notify).toHaveBeenCalledTimes(warningsAtDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns instead of throwing when widget rendering fails", () => {
    const notify = vi.fn();
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
    const broken = { ...row };
    Object.defineProperty(broken, "agent", {
      get: () => {
        throw new Error("render secret");
      },
    });
    const view = new AgentsView(
      { setWidget, notify } as unknown as ExtensionContext["ui"],
      () => [broken],
    );
    view.refresh();
    expect(component?.render()).toEqual([]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "[pi-subagents-minimal] Could not refresh the Agents view.",
      "warning",
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("secret");
    view.dispose();
  });

  it("advances active elapsed between 5s refreshes without recomputing rows", () => {
    vi.useFakeTimers();
    try {
      const active: AgentViewRow = {
        ...row,
        session_id: "00000000-0000-000b",
        label: "active",
        elapsedMs: 0,
      };
      const getRows = vi.fn(() => [active]);
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
        getRows,
      );
      view.refresh();
      expect(component?.render()[1]).toContain("0.0s");
      vi.advanceTimersByTime(100);
      expect(component?.render()[1]).toContain("0.1s");
      expect(getRows).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(900);
      expect(component?.render()[1]).toContain("1.0s");
      expect(getRows).toHaveBeenCalledTimes(1);
      expect(active.elapsedMs).toBe(0);
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps terminal elapsed frozen across animation ticks", () => {
    vi.useFakeTimers();
    try {
      const active: AgentViewRow = {
        ...row,
        session_id: "00000000-0000-0006",
        label: "active",
        elapsedMs: 0,
      };
      const done: AgentViewRow = {
        ...row,
        session_id: "00000000-0000-0017",
        label: "finished",
        elapsedMs: 5000,
        phase: "completed",
        terminalStatus: "completed",
      };
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
        () => [active, done],
      );
      view.refresh();
      expect(component?.render()[1]).toContain("0.0s");
      expect(component?.render()[3]).toContain("5.0s");
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("1.0s");
      expect(component?.render()[3]).toContain("5.0s");
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("2.0s");
      expect(component?.render()[3]).toContain("5.0s");
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebases elapsed on source refresh without double-counting", () => {
    vi.useFakeTimers();
    try {
      let snapshotElapsed = 0;
      const getRows = vi.fn((): AgentViewRow[] => [
        {
          ...row,
          session_id: "00000000-0000-0006",
          label: "active",
          elapsedMs: snapshotElapsed,
        },
      ]);
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
        getRows,
      );
      view.refresh();
      expect(component?.render()[1]).toContain("0.0s");
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("1.0s");
      snapshotElapsed = 1000;
      view.refresh();
      expect(component?.render()[1]).toContain("1.0s");
      vi.advanceTimersByTime(100);
      expect(component?.render()[1]).toContain("1.1s");
      expect(getRows).toHaveBeenCalledTimes(2);
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset elapsed when a fixed source snapshot repeats across periodic refresh", () => {
    vi.useFakeTimers();
    try {
      const source: AgentViewRow = {
        ...row,
        session_id: "00000000-0000-0006",
        label: "active",
        elapsedMs: 0,
      };
      const getRows = vi.fn((): AgentViewRow[] => [source]);
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
        getRows,
      );
      view.refresh();
      vi.advanceTimersByTime(2000);
      expect(component?.render()[1]).toContain("2.0s");
      vi.advanceTimersByTime(3000);
      expect(getRows.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(component?.render()[1]).toContain("5.0s");
      vi.advanceTimersByTime(100);
      expect(component?.render()[1]).toContain("5.1s");
      expect(source.elapsedMs).toBe(0);
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never regresses elapsed when a source refresh rolls back", () => {
    vi.useFakeTimers();
    try {
      let snapshotElapsed = 0;
      const seen: AgentViewRow[] = [];
      const getRows = vi.fn((): AgentViewRow[] => {
        const fresh: AgentViewRow = {
          ...row,
          session_id: "00000000-0000-0006",
          label: "active",
          elapsedMs: snapshotElapsed,
        };
        seen.push(fresh);
        return [fresh];
      });
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
        getRows,
      );
      view.refresh();
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("1.0s");
      snapshotElapsed = 500;
      view.refresh();
      expect(component?.render()[1]).toContain("1.0s");
      vi.advanceTimersByTime(100);
      expect(component?.render()[1]).toContain("1.1s");
      expect(
        seen.every((entry) => entry.elapsedMs === 0 || entry.elapsedMs === 500),
      ).toBe(true);
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes a newly terminal row at the reconciled elapsed when the source elapsed is lower", () => {
    vi.useFakeTimers();
    try {
      let terminal = false;
      const getRows = vi.fn((): AgentViewRow[] =>
        terminal
          ? [
              {
                ...row,
                session_id: "00000000-0000-0006",
                label: "finished",
                elapsedMs: 500,
                phase: "completed",
                terminalStatus: "completed",
              },
            ]
          : [
              {
                ...row,
                session_id: "00000000-0000-0006",
                label: "active",
                elapsedMs: 0,
              },
            ],
      );
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
        getRows,
      );
      view.refresh();
      vi.advanceTimersByTime(2000);
      expect(component?.render()[1]).toContain("2.0s");
      terminal = true;
      view.refresh();
      expect(component?.render()[1]).toContain("2.0s");
      expect(component?.render()[1]).toContain("✓");
      vi.advanceTimersByTime(2000);
      expect(component?.render()[1]).toContain("2.0s");
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays smooth when wall time jumps forward across a wall-derived source refresh", () => {
    vi.useFakeTimers();
    try {
      const createdAtMs = Date.now();
      const getRows = vi.fn((): AgentViewRow[] => [
        {
          ...row,
          session_id: "00000000-0000-0006",
          label: "active",
          elapsedMs: Date.now() - createdAtMs,
        },
      ]);
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
        getRows,
      );
      view.refresh();
      expect(component?.render()[1]).toContain("0.0s");
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("1.0s");
      vi.setSystemTime(new Date(Date.now() + 3_600_000));
      view.refresh();
      const settled = component?.render()[1] ?? "";
      expect(settled).toContain("1.0s");
      expect(settled).not.toContain("1h");
      vi.advanceTimersByTime(100);
      expect(component?.render()[1]).toContain("1.1s");
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues a resumed session from the frozen presentation value instead of jumping", () => {
    vi.useFakeTimers();
    try {
      let mode: "active" | "terminal" | "resumed" = "active";
      const getRows = vi.fn((): AgentViewRow[] => {
        if (mode === "terminal") {
          return [
            {
              ...row,
              session_id: "00000000-0000-0006",
              label: "finished",
              elapsedMs: 8000,
              phase: "completed",
              terminalStatus: "completed",
            },
          ];
        }
        if (mode === "resumed") {
          return [
            {
              ...row,
              session_id: "00000000-0000-0006",
              label: "resumed work",
              elapsedMs: 5000,
            },
          ];
        }
        return [
          {
            ...row,
            session_id: "00000000-0000-0006",
            label: "active",
            elapsedMs: 0,
          },
        ];
      });
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
        getRows,
      );
      view.refresh();
      vi.advanceTimersByTime(2000);
      expect(component?.render()[1]).toContain("2.0s");
      mode = "terminal";
      view.refresh();
      expect(component?.render()[1]).toContain("2.0s");
      expect(component?.render()[1]).toContain("✓");
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("2.0s");
      mode = "resumed";
      view.refresh();
      const resumed = component?.render()[1] ?? "";
      expect(resumed).toContain("2.0s");
      expect(resumed).not.toContain("5.0s");
      expect(resumed).not.toContain("✓");
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("3.0s");
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores wall-clock jumps while the monotonic presentation clock advances", () => {
    vi.useFakeTimers();
    try {
      const getRows = vi.fn((): AgentViewRow[] => [
        {
          ...row,
          session_id: "00000000-0000-0006",
          label: "active",
          elapsedMs: 0,
        },
      ]);
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
        getRows,
      );
      view.refresh();
      vi.advanceTimersByTime(1000);
      expect(component?.render()[1]).toContain("1.0s");
      vi.setSystemTime(new Date(Date.now() + 3_600_000));
      expect(component?.render()[1]).toContain("1.0s");
      vi.setSystemTime(new Date(Date.now() - 7_200_000));
      expect(component?.render()[1]).toContain("1.0s");
      vi.advanceTimersByTime(100);
      expect(component?.render()[1]).toContain("1.1s");
      view.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drives animation from the injectable presentation clock and never renders negative elapsed", () => {
    let now = 1000;
    const clock = () => now;
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
      () => [
        {
          ...row,
          session_id: "00000000-0000-0006",
          label: "active",
          elapsedMs: 0,
        },
      ],
      clock,
    );
    view.refresh();
    expect(component?.render()[1]).toContain("0.0s");
    now += 1000;
    expect(component?.render()[1]).toContain("1.0s");
    now -= 500;
    const regressed = component?.render()[1] ?? "";
    expect(regressed).toContain("0.5s");
    expect(regressed).not.toContain("-");
    view.refresh();
    now += 600;
    expect(component?.render()[1]).toContain("1.1s");
    view.dispose();
  });

  it("stops presentation updates after disposal", () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const getRows = vi.fn((): AgentViewRow[] => [
        {
          ...row,
          session_id: "00000000-0000-0006",
          label: "active",
          elapsedMs: 0,
        },
      ]);
      let component: { render(): string[] } | undefined;
      const setWidget = vi.fn((_key: string, factory: unknown) => {
        if (typeof factory === "function") {
          component = (
            factory as (
              tui: { requestRender(): void },
              theme: Theme,
            ) => { render(): string[] }
          )({ requestRender }, fakeTheme);
        }
      });
      const view = new AgentsView(
        { setWidget } as unknown as ExtensionContext["ui"],
        getRows,
      );
      view.refresh();
      expect(component?.render()[1]).toContain("0.0s");
      const rendersAtDispose = requestRender.mock.calls.length;
      view.dispose();
      vi.advanceTimersByTime(5000);
      expect(requestRender).toHaveBeenCalledTimes(rendersAtDispose);
      expect(getRows).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op without a TUI surface", () => {
    expect(() =>
      new AgentsView(undefined, () => [row]).refresh(),
    ).not.toThrow();
  });
});
