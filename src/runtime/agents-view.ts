import { notifyWarning } from "../diagnostics.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TerminalRunStatus, ThinkingLevel } from "../types.js";

export const AGENTS_VIEW_WARNING =
  "[pi-subagents-minimal] Could not refresh the Agents view.";
const WIDGET_KEY = "pi-subagents-minimal:agents";
const SPINNER_INTERVAL_MS = 80;
const SPINNER_FRAMES = ["⠐", "⠰", "⠴", "⠶", "⠶", "⠦", "⠖", "⠒", "⠐"] as const;

const TERMINAL_MARKERS: Record<TerminalRunStatus, string> = {
  completed: "✓",
  failed: "✕",
  stopped: "■",
  aborted: "■",
};

const TERMINAL_MARKER_COLORS: Record<
  TerminalRunStatus,
  "success" | "error" | "warning" | "dim"
> = {
  completed: "success",
  failed: "error",
  stopped: "warning",
  aborted: "dim",
};

export interface AgentViewRow {
  session_id: string;
  agent: string;
  label: string;
  elapsedMs: number;
  phase: string;
  queuePosition?: number;
  createdAt: string;
  terminalStatus?: TerminalRunStatus;
  turns: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  thinking?: ThinkingLevel;
}

export function deriveLabel(prompt: string): string {
  const label = (prompt.split(/\r?\n/).find((line) => line.trim() !== "") ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

export function derivePhase(
  status: "queued" | "running",
  queuePosition: number | undefined,
  turns = 0,
  tools = 0,
): string {
  if (status === "queued") return `queued (position ${queuePosition ?? 1})`;
  if (turns === 0) return "starting";
  return tools > 0
    ? `working · turn ${turns} · ${tools} tools`
    : `working · turn ${turns}`;
}

export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 60_000)
    return `${Math.max(0, milliseconds / 1000).toFixed(1)}s`;
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (milliseconds < 3_600_000) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  if (milliseconds < 86_400_000) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function orderedRows(rows: AgentViewRow[]): AgentViewRow[] {
  return [...rows].sort((left, right) => {
    const byWaiting =
      Number(left.queuePosition === undefined) -
      Number(right.queuePosition === undefined);
    return (
      byWaiting ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.session_id.localeCompare(right.session_id)
    );
  });
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${(tokens / 1_000_000_000).toFixed(1)}B`;
}

const MIN_TURNS_WIDTH = 7;
const MIN_TOKEN_WIDTH = 4;

interface StatsWidths {
  turns: number;
  input: number;
  output: number;
}

function turnText(row: AgentViewRow): string {
  return `${row.turns} turns`;
}

function inputText(row: AgentViewRow): string {
  return row.inputTokens === undefined ? "—" : compactTokens(row.inputTokens);
}

function outputText(row: AgentViewRow): string {
  return row.outputTokens === undefined ? "—" : compactTokens(row.outputTokens);
}

function computeStatsWidths(rows: AgentViewRow[]): StatsWidths {
  let turns = MIN_TURNS_WIDTH;
  let input = MIN_TOKEN_WIDTH;
  let output = MIN_TOKEN_WIDTH;
  for (const row of rows) {
    turns = Math.max(turns, turnText(row).length);
    input = Math.max(input, inputText(row).length);
    output = Math.max(output, outputText(row).length);
  }
  return { turns, input, output };
}

function modelText(row: AgentViewRow): string {
  return row.model ?? "—";
}

function thinkingText(row: AgentViewRow): string {
  return row.thinking ?? "—";
}

function formatStats(row: AgentViewRow, widths: StatsWidths): string {
  return `▪ ${modelText(row)} · ${thinkingText(row)} · ${turnText(row).padStart(widths.turns)} · ${inputText(row).padStart(widths.input)} in / ${outputText(row).padStart(widths.output)} out`;
}

function workingCount(ordered: AgentViewRow[]): number {
  return ordered.filter((row) => row.terminalStatus === undefined).length;
}

function finishedCount(ordered: AgentViewRow[]): number {
  return ordered.length - workingCount(ordered);
}

function headerText(ordered: AgentViewRow[]): string {
  return `❯ Agents · ${workingCount(ordered)} working · ${finishedCount(ordered)} finished`;
}

export function renderAgents(
  rows: AgentViewRow[],
  spinner = SPINNER_FRAMES[0],
): string[] {
  const ordered = orderedRows(rows);
  const widths = computeStatsWidths(ordered);
  const lines = [headerText(ordered)];
  ordered.forEach((row, index) => {
    const final = index === ordered.length - 1;
    const branch = final ? "└─" : "├─";
    const marker =
      row.terminalStatus === undefined
        ? spinner
        : TERMINAL_MARKERS[row.terminalStatus];
    lines.push(
      `${branch} ${marker} ${row.agent} · ${row.label} · ${formatElapsed(row.elapsedMs)}`,
    );
    lines.push(`${final ? "     " : "│    "}${formatStats(row, widths)}`);
  });
  return lines;
}

function renderThemedAgents(
  rows: AgentViewRow[],
  spinner: string,
  theme: Theme,
): string[] {
  const ordered = orderedRows(rows);
  const widths = computeStatsWidths(ordered);
  const lines = [
    theme.fg("accent", "❯ ") +
      theme.fg("accent", theme.bold("Agents")) +
      theme.fg("dim", " · ") +
      theme.fg("dim", `${workingCount(ordered)} working`) +
      theme.fg("dim", " · ") +
      theme.fg("dim", `${finishedCount(ordered)} finished`),
  ];
  ordered.forEach((row, index) => {
    const final = index === ordered.length - 1;
    const branch = final ? "└─" : "├─";
    const marker =
      row.terminalStatus !== undefined
        ? theme.fg(
            TERMINAL_MARKER_COLORS[row.terminalStatus],
            TERMINAL_MARKERS[row.terminalStatus],
          )
        : theme.fg("accent", spinner);
    lines.push(
      theme.fg("muted", `${branch} `) +
        marker +
        theme.fg("text", ` ${row.agent}`) +
        theme.fg("dim", ` · ${row.label} · ${formatElapsed(row.elapsedMs)}`),
    );
    lines.push(
      theme.fg("muted", final ? "     " : "│    ") +
        theme.fg("dim", formatStats(row, widths)),
    );
  });
  return lines;
}

/** Per-parent presenter. Host calls are isolated so rendering can never affect execution. */
export class AgentsView {
  private mounted = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private spinnerFrame = 0;
  private requestRender?: () => void;
  private requestRenderWarned = false;
  private rows: AgentViewRow[] = [];
  private refreshedAtMs = 0;
  private readonly clock: () => number;

  constructor(
    private readonly ui: ExtensionContext["ui"] | undefined,
    private readonly getRows: (nowMs?: number) => AgentViewRow[],
    clock: () => number = () => performance.now(),
  ) {
    this.clock = clock;
  }

  /**
   * Re-render from live rows and return the exact snapshot that was rendered,
   * so callers can base emptiness and timer decisions on one consistent read.
   *
   * Elapsed-time policy: for a session ID the view has already shown, the
   * monotonic presentation value is authoritative. Refreshes keep the
   * previously displayed elapsed for that ID across active-to-active updates
   * and active-to-terminal settlement (freezing the terminal row there), so
   * wall-clock-derived source elapsed is never accepted in either direction.
   * A terminal-to-active transition for a known ID is a resume of the same
   * execution lineage (resumes reuse the session ID); it continues accruing
   * from the frozen presentation value instead of jumping to the source
   * elapsed. Only brand-new session IDs accept their initial source elapsed,
   * which is how new runs establish their baseline.
   */
  refresh(nowMs?: number): AgentViewRow[] {
    try {
      const incoming = this.getRows(nowMs);
      const now = this.clock();
      const carriedDeltaMs = Math.max(0, now - this.refreshedAtMs);
      const previouslyDisplayed = new Map<string, number>();
      for (const oldRow of this.rows) {
        const displayed =
          oldRow.terminalStatus !== undefined
            ? oldRow.elapsedMs
            : oldRow.elapsedMs + carriedDeltaMs;
        const existing = previouslyDisplayed.get(oldRow.session_id);
        if (existing === undefined || displayed > existing) {
          previouslyDisplayed.set(oldRow.session_id, displayed);
        }
      }
      this.rows = incoming.map((incomingRow) => {
        const previous = previouslyDisplayed.get(incomingRow.session_id);
        if (previous === undefined) {
          return incomingRow;
        }
        return { ...incomingRow, elapsedMs: previous };
      });
      this.refreshedAtMs = now;
      if (this.rows.length === 0) {
        this.dispose();
      } else {
        if (!this.mounted) this.mount();
        this.requestHostRender();
      }
    } catch {
      notifyWarning(this.ui, AGENTS_VIEW_WARNING);
    }
    return [...this.rows];
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.refreshTimer = undefined;
    this.spinnerTimer = undefined;
    if (this.mounted) {
      try {
        this.ui?.setWidget?.(WIDGET_KEY, undefined);
      } catch {
        notifyWarning(this.ui, AGENTS_VIEW_WARNING);
      }
    }
    this.mounted = false;
    this.requestRender = undefined;
  }

  private displayRows(): AgentViewRow[] {
    const deltaMs = this.clock() - this.refreshedAtMs;
    const safeDeltaMs = deltaMs > 0 ? deltaMs : 0;
    if (safeDeltaMs === 0) return this.rows;
    return this.rows.map((row) =>
      row.terminalStatus !== undefined
        ? row
        : { ...row, elapsedMs: row.elapsedMs + safeDeltaMs },
    );
  }

  private requestHostRender(): void {
    try {
      this.requestRender?.();
    } catch {
      if (!this.requestRenderWarned) {
        this.requestRenderWarned = true;
        notifyWarning(this.ui, AGENTS_VIEW_WARNING);
      }
    }
  }

  private mount(): void {
    if (!this.ui || typeof this.ui.setWidget !== "function") return;
    this.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        this.requestRender = () => tui.requestRender();
        return {
          render: () => {
            try {
              return renderThemedAgents(
                this.displayRows(),
                SPINNER_FRAMES[this.spinnerFrame],
                theme,
              );
            } catch {
              notifyWarning(this.ui, AGENTS_VIEW_WARNING);
              return [];
            }
          },
          invalidate: () => undefined,
        };
      },
      { placement: "aboveEditor" },
    );
    this.mounted = true;
    this.refreshTimer = setInterval(() => this.refresh(), 5000);
    this.refreshTimer.unref?.();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestHostRender();
    }, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref?.();
  }
}
