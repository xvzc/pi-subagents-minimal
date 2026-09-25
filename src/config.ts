/**
 * Layered configuration for pi-subagents-minimal (S8-S16, C1-C4).
 *
 * The effective configuration merges three layers field by field: built-in
 * defaults, then valid global fields, then valid project fields (S8, S13).
 * Each file is read at most once per activation; the returned object is
 * frozen so every consumer shares one immutable configuration (D1).
 *
 * Tolerance policy (D2, S9-S12): missing files are silent; invalid JSON or a
 * non-object root warns once and contributes nothing; an invalid known field
 * warns and keeps its lower-precedence value; unknown fields warn and are
 * ignored. Warnings identify path, field, and reason but never include file
 * contents or invalid values.
 *
 * The loader reads only the two explicit config paths (C1, C2). It never
 * reads credential files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel, type MinimalSubagentsConfig } from "./types.js";

/** Config file name shared by the global and project layers (C1, C2). */
export const CONFIG_FILE_NAME = "pi-subagents-minimal.json";

/** Built-in defaults (C3, C4): retention `7` with absent model/thinking. */
export const DEFAULT_CONFIG: MinimalSubagentsConfig = Object.freeze({
  historyRetentionDays: 7,
  maxConcurrentSubagents: 8,
  injectGuidelines: true,
});

/** Numeric effective fields, each validated as a ranged safe integer (S14). */
type NumericField = Exclude<
  keyof MinimalSubagentsConfig,
  "defaultModel" | "defaultThinking" | "injectGuidelines"
>;

/** Inclusive bounds for each numeric field (S14). */
const NUMERIC_BOUNDS: Record<
  NumericField,
  readonly [min: number, max: number]
> = {
  historyRetentionDays: [1, 3650],
  maxConcurrentSubagents: [1, 64],
};

/** Fixed redacted config warning prefixed for delivery. */
export type ConfigWarningSink = (message: string) => void;

/** Path overrides. Production callers omit both so host values apply. */
export interface ConfigLoadOptions {
  /** Agent directory override; defaults to the Pi host value (C1). */
  agentDir?: string;
  /** Working directory override; defaults to `process.cwd()` (C2). */
  cwd?: string;
  /** Explicit warning sink; callers that omit it receive nothing (010 S5). */
  onWarning?: ConfigWarningSink;
}

/** Global config path: `<agent-dir>/extensions/pi-subagents-minimal.json` (C1). */
export function globalConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", CONFIG_FILE_NAME);
}

/** Project config path: `<cwd>/.pi/pi-subagents-minimal.json` (C2). */
export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, ".pi", CONFIG_FILE_NAME);
}

/**
 * Read one layer file into the draft. Missing files are silent (S9); unreadable
 * files, invalid JSON, and non-object roots warn once and contribute nothing
 * (S10). Parse warnings use fixed reasons: V8 syntax messages can echo the
 * file contents, which must never leak into warnings.
 */
function readLayer(
  path: string,
  draft: MinimalSubagentsConfig,
  warn: ConfigWarningSink,
): void {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    const reason = err instanceof Error ? err.message : "unreadable file";
    warn(`Ignoring unreadable config at ${path}: ${reason}.`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    warn(`Ignoring malformed config at ${path}: invalid JSON.`);
    return;
  }
  if (!isRecord(parsed)) {
    warn(`Ignoring malformed config at ${path}: expected a JSON object.`);
    return;
  }
  applyLayer(path, parsed, draft, warn);
}

/** True for a parsed JSON object root. Arrays never count as layers (S10). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge one parsed layer into the draft field by field (S11-S13).
 * Invalid known fields warn and keep the lower-precedence value; unknown
 * fields warn and are ignored. Never includes values in warnings.
 */
function applyLayer(
  path: string,
  raw: Record<string, unknown>,
  draft: MinimalSubagentsConfig,
  warn: ConfigWarningSink,
): void {
  for (const [field, value] of Object.entries(raw)) {
    switch (field) {
      case "historyRetentionDays":
      case "maxConcurrentSubagents": {
        const [min, max] = NUMERIC_BOUNDS[field];
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < min ||
          value > max
        ) {
          warn(
            `Ignoring invalid "${field}" in ${path}: expected a safe integer ${min}-${max}.`,
          );
        } else {
          draft[field] = value;
        }
        break;
      }
      case "defaultModel": {
        if (typeof value !== "string" || value.trim().length === 0) {
          warn(
            `Ignoring invalid "defaultModel" in ${path}: expected a non-empty string.`,
          );
        } else {
          draft.defaultModel = value.trim();
        }
        break;
      }
      case "defaultThinking": {
        if (!isThinkingLevel(value)) {
          warn(
            `Ignoring invalid "defaultThinking" in ${path}: ` +
              "expected one of off, minimal, low, medium, high, xhigh, max.",
          );
        } else {
          draft.defaultThinking = value;
        }
        break;
      }
      case "injectGuidelines": {
        if (typeof value !== "boolean") {
          warn(
            `Ignoring invalid "injectGuidelines" in ${path}: expected a boolean.`,
          );
        } else {
          draft.injectGuidelines = value;
        }
        break;
      }
      default: {
        warn(`Ignoring unknown config field "${field}" in ${path}.`);
        break;
      }
    }
  }
}

/**
 * Validation and parse paths report the same prefixed, redacted strings
 * through `options.onWarning`; a caller that omits the sink stays silent
 * (010 S5, D2). Never throws for missing or invalid configuration (N1).
 */
export function loadEffectiveConfig(
  options: ConfigLoadOptions = {},
): MinimalSubagentsConfig {
  const warn: ConfigWarningSink = (message) =>
    options.onWarning?.(`[pi-subagents-minimal] ${message}`);
  const draft: MinimalSubagentsConfig = { ...DEFAULT_CONFIG };
  readLayer(globalConfigPath(options.agentDir ?? getAgentDir()), draft, warn);
  readLayer(projectConfigPath(options.cwd ?? process.cwd()), draft, warn);
  return Object.freeze(draft) as MinimalSubagentsConfig;
}
