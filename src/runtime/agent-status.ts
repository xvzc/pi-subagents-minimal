import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Container,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { isErrorEnvelope } from "../errors.js";
import { sanitizeReasonText } from "./agent-output.js";

export const AGENT_STATUS_GENERIC_FAILURE = "Agent status failed.";
const AGENT_STATUS_EMPTY = "No subagent sessions.";

const MAX_AGENT_CHARS = 80;
const MAX_STATUS_CHARS = 20;
const MAX_SESSION_CHARS = 64;

const AGENT_STATUS_GLYPHS: Record<string, string> = {
  queued: "○",
  running: "●",
  completed: "✓",
  failed: "x",
  stopped: "■",
  aborted: "!",
};

const AGENT_STATUS_OK = new Set(["queued", "running", "completed"]);

export interface AgentStatusEntry {
  agent: string;
  status: string;
  session_id: string;
}

export interface AgentStatusData {
  active: AgentStatusEntry[];
  recent: AgentStatusEntry[];
}

function statusField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (safe.length === 0) return undefined;
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

function statusEntry(value: unknown): AgentStatusEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const agent = statusField(record.agent, MAX_AGENT_CHARS);
  const session_id = statusField(record.session_id, MAX_SESSION_CHARS);
  if (agent === undefined || session_id === undefined) return undefined;
  const rawStatus = statusField(record.status, MAX_STATUS_CHARS) ?? "unknown";
  return { agent, status: rawStatus, session_id };
}

function statusList(value: unknown): AgentStatusEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AgentStatusEntry[] = [];
  for (const item of value) {
    const entry = statusEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Extract active/recent summaries; error envelopes and malformed payloads yield safe fallbacks without throwing. */
export function agentStatusData(details: unknown): AgentStatusData {
  try {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return { active: [], recent: [] };
    }
    const record = details as Record<string, unknown>;
    return {
      active: statusList(record.active_sessions),
      recent: statusList(record.recent_sessions),
    };
  } catch {
    return { active: [], recent: [] };
  }
}

/** Safe one-line status failure reason: the error message when usable, else the error code, else a generic label. */
export function agentStatusFailureReason(details: unknown): string {
  if (isErrorEnvelope(details)) {
    const byMessage = sanitizeReasonText(details.error.message);
    if (byMessage.length > 0) return byMessage;
    const byCode = sanitizeReasonText(details.error.code);
    if (byCode.length > 0) return byCode;
  }
  return AGENT_STATUS_GENERIC_FAILURE;
}

function statusRow(entry: AgentStatusEntry, theme: Theme): Text {
  const glyph = AGENT_STATUS_GLYPHS[entry.status] ?? "?";
  const color: ThemeColor = AGENT_STATUS_OK.has(entry.status)
    ? "toolOutput"
    : "warning";
  return new Text(
    `${theme.fg(color, glyph)} ${theme.fg(color, `${entry.agent} · ${entry.status} · ${entry.session_id}`)}`,
    2,
    0,
  );
}

/**
 * Render `subagent_status` with the Agent Call/Agent Output visual
 * conventions. Collapsed shows only the heading with session counts;
 * expanded adds one indented row per session. The default tool call row is
 * hidden by `renderCall`, so this is the only visible region. Error
 * envelopes render an `x` heading with an always-visible reason; malformed
 * payloads fall back to the compact empty state. Never throws.
 */
export function renderAgentStatus(
  details: unknown,
  expanded: boolean,
  theme: Theme,
): Container {
  const container = new Container();
  try {
    if (isErrorEnvelope(details)) {
      container.addChild(
        new Text(
          `${theme.fg("error", "x")} ${theme.fg("toolTitle", "Agent Status")}`,
          0,
          0,
        ),
      );
      container.addChild(
        new Text(theme.fg("error", agentStatusFailureReason(details)), 2, 0),
      );
      return container;
    }
    const { active, recent } = agentStatusData(details);
    const heading =
      active.length === 0 && recent.length === 0
        ? `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Agent Status")}${theme.fg("dim", " · no sessions")}`
        : `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Agent Status")}${theme.fg("dim", ` · ${active.length} active · ${recent.length} recent`)}`;
    container.addChild(new Text(heading, 0, 0));
    if (expanded) {
      if (active.length === 0 && recent.length === 0) {
        container.addChild(
          new Text(theme.fg("toolOutput", AGENT_STATUS_EMPTY), 2, 0),
        );
      } else {
        for (const entry of [...active, ...recent]) {
          container.addChild(statusRow(entry, theme));
        }
      }
    }
    return container;
  } catch {
    const fallback = new Container();
    fallback.addChild(
      new Text(
        `${theme.fg("error", "x")} ${theme.fg("toolTitle", "Agent Status")}`,
        0,
        0,
      ),
    );
    fallback.addChild(
      new Text(theme.fg("error", AGENT_STATUS_GENERIC_FAILURE), 2, 0),
    );
    return fallback;
  }
}
