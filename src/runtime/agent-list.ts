import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { isErrorEnvelope } from "../errors.js";
import { sanitizeReasonText } from "./agent-output.js";

export const AGENT_LIST_GENERIC_FAILURE = "Agent list failed.";
const AGENT_LIST_EMPTY = "No agents available.";

const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_MODEL_CHARS = 40;
const MAX_THINKING_CHARS = 20;
const MAX_TOOL_CHARS = 40;
const MAX_TOOLS_SHOWN = 20;
const MAX_EXTENSION_CHARS = 80;
const MAX_EXTENSIONS_SHOWN = 20;
const MAX_SOURCE_CHARS = 20;
const MAX_WARNING_PATH_CHARS = 200;
const MAX_WARNING_MESSAGE_CHARS = 120;

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

export interface AgentListEntry {
  name: string;
  source?: string;
  description?: string;
  model?: string;
  thinking?: string;
  max_turns?: number;
  tools?: true | string[];
  disallowed_tools?: string[];
  skills?: true | string[];
  disallowed_skills?: string[];
  /** Configured source strings only; resolved filesystem paths are never listed. */
  extensions?: string[];
}

export interface AgentListWarning {
  path: string;
  message: string;
}

export interface AgentListData {
  agents: AgentListEntry[];
  warnings: AgentListWarning[];
}

function listField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = stripTerminalSequences(value)
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (safe.length === 0) return undefined;
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

function listEntry(value: unknown): AgentListEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const name = listField(record.name, MAX_NAME_CHARS);
  if (name === undefined) return undefined;
  const entry: AgentListEntry = { name };
  const source = listField(record.source, MAX_SOURCE_CHARS);
  if (source !== undefined) entry.source = source;
  const description = listField(record.description, MAX_DESCRIPTION_CHARS);
  if (description !== undefined) entry.description = description;
  const model = listField(record.model, MAX_MODEL_CHARS);
  if (model !== undefined) entry.model = model;
  const thinking = listField(record.thinking, MAX_THINKING_CHARS);
  if (thinking !== undefined) entry.thinking = thinking;
  const maxTurns = record.max_turns;
  if (typeof maxTurns === "number" && Number.isFinite(maxTurns)) {
    entry.max_turns = maxTurns;
  }
  const policy = (value: unknown): true | string[] | undefined => {
    if (value === true) return true;
    if (!Array.isArray(value)) return undefined;
    const names: string[] = [];
    for (const item of value.slice(0, MAX_TOOLS_SHOWN)) {
      const safe = listField(item, MAX_TOOL_CHARS);
      if (safe !== undefined) names.push(safe);
    }
    if (value.length > MAX_TOOLS_SHOWN) names.push("…");
    return names;
  };
  const tools = policy(record.tools);
  if (tools !== undefined) entry.tools = tools;
  const disallowedTools = policy(record.disallowed_tools);
  if (disallowedTools !== undefined && disallowedTools !== true)
    entry.disallowed_tools = disallowedTools;
  const skills = policy(record.skills);
  if (skills !== undefined) entry.skills = skills;
  const disallowedSkills = policy(record.disallowed_skills);
  if (disallowedSkills !== undefined && disallowedSkills !== true)
    entry.disallowed_skills = disallowedSkills;
  if (Array.isArray(record.extensions)) {
    const extensions: string[] = [];
    for (const source of record.extensions.slice(0, MAX_EXTENSIONS_SHOWN)) {
      const safe = listField(source, MAX_EXTENSION_CHARS);
      if (safe !== undefined) extensions.push(safe);
    }
    entry.extensions = extensions;
    if (record.extensions.length > MAX_EXTENSIONS_SHOWN)
      entry.extensions.push("…");
  }
  return entry;
}

function listWarning(value: unknown): AgentListWarning | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const path = listField(record.path, MAX_WARNING_PATH_CHARS);
  const message = listField(record.message, MAX_WARNING_MESSAGE_CHARS);
  if (path === undefined || message === undefined) return undefined;
  return { path, message };
}

/** Extract agents/warnings; error envelopes and malformed payloads yield safe fallbacks without throwing. */
export function agentListData(details: unknown): AgentListData {
  try {
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return { agents: [], warnings: [] };
    }
    const record = details as Record<string, unknown>;
    const agents: AgentListEntry[] = [];
    if (Array.isArray(record.agents)) {
      for (const item of record.agents) {
        const entry = listEntry(item);
        if (entry) agents.push(entry);
      }
    }
    const warnings: AgentListWarning[] = [];
    if (Array.isArray(record.warnings)) {
      for (const item of record.warnings) {
        const warning = listWarning(item);
        if (warning) warnings.push(warning);
      }
    }
    return { agents, warnings };
  } catch {
    return { agents: [], warnings: [] };
  }
}

/** Safe one-line list failure reason: the error message when usable, else the error code, else a generic label. */
export function agentListFailureReason(details: unknown): string {
  if (isErrorEnvelope(details)) {
    const byMessage = sanitizeReasonText(details.error.message);
    if (byMessage.length > 0) return byMessage;
    const byCode = sanitizeReasonText(details.error.code);
    if (byCode.length > 0) return byCode;
  }
  return AGENT_LIST_GENERIC_FAILURE;
}

function warningCountSuffix(warnings: number): string {
  if (warnings === 0) return "";
  return warnings === 1 ? " · 1 warning" : ` · ${warnings} warnings`;
}

function agentRows(entry: AgentListEntry, theme: Theme): Text[] {
  const rows: Text[] = [];
  const nameSource =
    entry.source !== undefined ? `${entry.name} · ${entry.source}` : entry.name;
  rows.push(
    new Text(`${theme.fg("accent", "•")} ${theme.fg("dim", nameSource)}`, 2, 0),
  );
  if (entry.description !== undefined) {
    rows.push(new Text(theme.fg("toolOutput", entry.description), 4, 0));
  }
  const metadata: string[] = [];
  if (entry.model !== undefined) metadata.push(`model: ${entry.model}`);
  if (entry.thinking !== undefined)
    metadata.push(`thinking: ${entry.thinking}`);
  if (entry.max_turns !== undefined)
    metadata.push(`max turns: ${entry.max_turns}`);
  if (metadata.length > 0) {
    rows.push(new Text(theme.fg("dim", metadata.join(" · ")), 4, 0));
  }
  if (entry.tools !== undefined) {
    const toolsText =
      entry.tools === true
        ? "all"
        : entry.tools.length > 0
          ? entry.tools.join(", ")
          : "(none)";
    rows.push(new Text(theme.fg("dim", `tools: ${toolsText}`), 4, 0));
  }
  if (entry.disallowed_tools !== undefined) {
    const disallowedText =
      entry.disallowed_tools.length > 0
        ? entry.disallowed_tools.join(", ")
        : "(none)";
    rows.push(
      new Text(theme.fg("dim", `disallowed tools: ${disallowedText}`), 4, 0),
    );
  }
  if (entry.skills !== undefined) {
    const skillsText =
      entry.skills === true
        ? "all"
        : entry.skills.length > 0
          ? entry.skills.join(", ")
          : "(none)";
    rows.push(new Text(theme.fg("dim", `skills: ${skillsText}`), 4, 0));
  }
  if (entry.disallowed_skills !== undefined) {
    const disallowedText =
      entry.disallowed_skills.length > 0
        ? entry.disallowed_skills.join(", ")
        : "(none)";
    rows.push(
      new Text(theme.fg("dim", `disallowed skills: ${disallowedText}`), 4, 0),
    );
  }
  if (entry.extensions !== undefined) {
    const extensionsText =
      entry.extensions.length > 0 ? entry.extensions.join(", ") : "(none)";
    rows.push(new Text(theme.fg("dim", `extensions: ${extensionsText}`), 4, 0));
  }
  return rows;
}

/**
 * Render `subagent_list` with the Agent Status visual conventions. Collapsed
 * shows only the heading with the enabled count (plus a warning count when
 * present); expanded adds per-agent detail rows and warning rows. The
 * default tool call row is hidden by `renderCall`, so this is the only
 * visible region. Error envelopes render an `x` heading with an
 * always-visible reason; malformed payloads fall back to the compact empty
 * state. Never throws.
 */
export function renderAgentList(
  details: unknown,
  expanded: boolean,
  theme: Theme,
): Container {
  const container = new Container();
  try {
    if (isErrorEnvelope(details)) {
      container.addChild(
        new Text(
          `${theme.fg("error", "x")} ${theme.fg("toolTitle", "Agent List")}`,
          0,
          0,
        ),
      );
      container.addChild(
        new Text(theme.fg("error", agentListFailureReason(details)), 2, 0),
      );
      return container;
    }
    const { agents, warnings } = agentListData(details);
    const counts =
      agents.length === 0 ? " · no agents" : ` · ${agents.length} enabled`;
    const heading =
      `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Agent List")}` +
      `${theme.fg("dim", `${counts}${warningCountSuffix(warnings.length)}`)}`;
    container.addChild(new Text(heading, 0, 0));
    if (expanded) {
      if (agents.length === 0 && warnings.length === 0) {
        container.addChild(
          new Text(theme.fg("toolOutput", AGENT_LIST_EMPTY), 2, 0),
        );
      } else {
        for (const entry of agents) {
          for (const row of agentRows(entry, theme)) container.addChild(row);
        }
        for (const warning of warnings) {
          container.addChild(
            new Text(
              `${theme.fg("warning", "!")} ${theme.fg("dim", `${warning.path} · ${warning.message}`)}`,
              2,
              0,
            ),
          );
        }
      }
    }
    return container;
  } catch {
    const fallback = new Container();
    fallback.addChild(
      new Text(
        `${theme.fg("error", "x")} ${theme.fg("toolTitle", "Agent List")}`,
        0,
        0,
      ),
    );
    fallback.addChild(
      new Text(theme.fg("error", AGENT_LIST_GENERIC_FAILURE), 2, 0),
    );
    return fallback;
  }
}
