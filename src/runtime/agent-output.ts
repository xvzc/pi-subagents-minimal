import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { isErrorEnvelope } from "../errors.js";

export const SUBAGENT_CALL_PRESENTATION_KEY = "__pi_subagents_minimal_ui";

export const MAX_REASON_CHARS = 120;
const MAX_EXPANDED_OUTPUT_CHARS = 100_000;

/** Generic safe label when a failure carries no usable message, code, or status. */
export const AGENT_OUTPUT_GENERIC_FAILURE = "Agent failed.";

export interface AgentOutputData {
  agent?: string;
  output?: string;
  status?: string;
  error?: string;
}

export function agentOutputAgent(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  if ("agent" in details && typeof details.agent === "string")
    return details.agent;
  if (!(SUBAGENT_CALL_PRESENTATION_KEY in details)) return undefined;
  const presentation = details[SUBAGENT_CALL_PRESENTATION_KEY];
  if (
    !presentation ||
    typeof presentation !== "object" ||
    !("agent" in presentation)
  ) {
    return undefined;
  }
  return typeof presentation.agent === "string"
    ? presentation.agent
    : undefined;
}

export function agentOutputData(details: unknown): AgentOutputData {
  if (!details || typeof details !== "object") return {};
  const value = details as Record<string, unknown>;
  const error =
    typeof value.error === "string"
      ? value.error
      : value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>).message
        : undefined;
  return {
    ...(agentOutputAgent(details) ? { agent: agentOutputAgent(details) } : {}),
    ...(typeof value.output === "string" ? { output: value.output } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof error === "string" ? { error } : {}),
  };
}

function displayText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One-line sanitized reason text, capped so untrusted/huge errors cannot flood the UI. */
export function sanitizeReasonText(value: string): string {
  const safe = displayText(value);
  if (safe.length <= MAX_REASON_CHARS) return safe;
  return `${safe.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function expandedText(value: string): string {
  const safe = stripTerminalSequences(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .trimEnd();
  if (safe.length <= MAX_EXPANDED_OUTPUT_CHARS) return safe;
  return `${safe.slice(0, MAX_EXPANDED_OUTPUT_CHARS)}\n… (output truncated for display)`;
}

const AGENT_OUTPUT_FAILURE_STATUSES = new Set(["failed", "aborted", "stopped"]);

function rawErrorCode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const error = (raw as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error))
    return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Safe one-line failure reason: the error message when usable, else the error
 * code, else the terminal failure status, else undefined (the caller falls
 * back to a generic safe label).
 */
export function agentOutputFailureReason(
  details: AgentOutputData,
  raw?: unknown,
): string | undefined {
  if (
    details.error !== undefined &&
    sanitizeReasonText(details.error).length > 0
  ) {
    return sanitizeReasonText(details.error);
  }
  const code = rawErrorCode(raw);
  if (code !== undefined && sanitizeReasonText(code).length > 0) {
    return sanitizeReasonText(code);
  }
  if (
    details.status !== undefined &&
    AGENT_OUTPUT_FAILURE_STATUSES.has(details.status)
  ) {
    return sanitizeReasonText(details.status);
  }
  return undefined;
}

/**
 * True when Agent Output must use the `x` failure glyph: a retrieval error
 * envelope, any present `error` field, or a terminal failure status
 * (`failed`, `aborted`, `stopped`). `completed` (even with a status-only
 * body) stays `❯`.
 */
export function isAgentOutputFailure(
  details: AgentOutputData,
  raw?: unknown,
): boolean {
  if (details.error !== undefined) return true;
  if (raw !== undefined && isErrorEnvelope(raw)) return true;
  if (
    raw !== undefined &&
    typeof raw === "object" &&
    raw !== null &&
    "error" in raw &&
    (raw as Record<string, unknown>).error !== undefined
  ) {
    return true;
  }
  return (
    details.status !== undefined &&
    AGENT_OUTPUT_FAILURE_STATUSES.has(details.status)
  );
}

export function renderAgentOutput(
  details: AgentOutputData,
  expanded: boolean,
  theme: Theme,
  raw?: unknown,
  providerErrorMessage?: string,
): Container {
  const container = new Container();
  const error = details.error;
  const failed = isAgentOutputFailure(details, raw);
  container.addChild(
    new Text(
      failed
        ? `${theme.fg("error", "x")} ${theme.fg("toolTitle", "Agent Output")}` +
            (details.agent
              ? theme.fg("dim", ` · ${displayText(details.agent)}`)
              : "")
        : `${theme.fg("success", "❮")} ${theme.fg("toolTitle", "Agent Output")}` +
            (details.agent
              ? theme.fg("dim", ` · ${displayText(details.agent)}`)
              : ""),
      0,
      0,
    ),
  );
  if (failed) {
    // The reason is always visible, even when collapsed, so failures are never
    // silent. The heading carries only glyph/title/metadata.
    const reason =
      agentOutputFailureReason(details, raw) ?? AGENT_OUTPUT_GENERIC_FAILURE;
    container.addChild(new Text(theme.fg("error", reason), 2, 0));
    if (expanded) {
      if (details.output !== undefined) {
        // Preserve actual/partial output alongside the reason, unless it
        // reformats to the already-visible reason.
        const fullOutput = expandedText(details.output);
        if (fullOutput.trim() !== reason) {
          container.addChild(
            new Text(theme.fg("toolOutput", fullOutput), 2, 0),
          );
        }
      } else if (error !== undefined) {
        // No output: show the full error only when it adds detail beyond the
        // one-line reason (multiline or over-cap content).
        const full = expandedText(error);
        if (full.trim() !== reason) {
          container.addChild(new Text(theme.fg("toolOutput", full), 2, 0));
        }
      }
      if (providerErrorMessage !== undefined) {
        const providerText = expandedText(
          providerErrorMessage.replace(/\r/g, " "),
        );
        if (providerText.trim() !== "") {
          container.addChild(
            new Text(theme.fg("toolOutput", providerText), 2, 0),
          );
        }
      }
    }
    return container;
  }
  if (expanded) {
    const body =
      details.output ?? details.status ?? "Terminal status unavailable.";
    container.addChild(
      new Text(theme.fg("toolOutput", expandedText(body)), 2, 0),
    );
  }
  return container;
}
