/**
 * Shared contracts for pi-subagents-minimal.
 *
 * This module owns IDs, run states, snapshots, configuration, and narrow
 * service interfaces. It must not depend on session or storage
 * implementation details (N3); later features implement the services declared
 * here without changing these boundaries.
 */

import { randomBytes } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  SubagentCallParams,
  SubagentListParams,
  SubagentOutputParams,
  SubagentStatusParams,
} from "./schemas.js";

// ---- Identifiers (S2, S3) ----

/** Session identifier: 16 lowercase hexadecimal digits grouped `8-4-4`. */
export type SessionId = string & { readonly __kind: "SessionId" };

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}$/;

/** True when `value` has the exact session ID format. */
export function isSessionId(value: unknown): value is SessionId {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** Generate a session ID from exactly eight cryptographically random bytes. */
export function createSessionId(
  createRandomBytes: (size: number) => Uint8Array = randomBytes,
): SessionId {
  const bytes = createRandomBytes(8);
  if (bytes.byteLength !== 8) {
    throw new Error("Session ID generation requires exactly 8 random bytes.");
  }
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}` as SessionId;
}

/**
 * Assert that `value` has the session ID format.
 * Throws a plain Error; the owning feature converts this to a coded
 * envelope (`SESSION_NOT_FOUND`) at its boundary.
 */
export function assertSessionId(
  value: string,
  field = "session_id",
): asserts value is SessionId {
  if (!isSessionId(value)) {
    throw new Error(
      `Invalid ${field}: expected 16 lowercase hexadecimal digits grouped 8-4-4.`,
    );
  }
}

// ---- Run states (S5, S6) ----

/** Run states for sessions. */
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "stopped" | "aborted";

export const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
  "aborted",
];

/** States with no `completed_at`: still active. */
export type ActiveRunStatus = "queued" | "running";

/** States that carry a `completed_at`: terminal. */
export type TerminalRunStatus = "completed" | "failed" | "stopped" | "aborted";

/** True for one of the six run states. */
export function isRunStatus(value: unknown): value is RunStatus {
  return (
    typeof value === "string" &&
    (RUN_STATUSES as readonly string[]).includes(value)
  );
}

/** True when the status is terminal and therefore carries `completed_at` (S6). */
export function isTerminalStatus(
  status: RunStatus,
): status is TerminalRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "stopped" ||
    status === "aborted"
  );
}

// ---- Thinking levels (C5) ----

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** True for one of the seven supported thinking names. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

// ---- Snapshots (S6, S7) ----

/**
 * Minimal observed summary of a session. Status tools report summaries, never
 * full output; `completed_at` is present only for terminal records (S6).
 * Reported fields are observed, never fabricated (S7).
 */
export interface SessionSummary {
  session_id: SessionId;
  agent: string;
  status: RunStatus;
  started_at?: string;
  completed_at?: string;
}

// ---- Agent registry (001-agent-registry, S15) ----

/** Where a normalized agent definition was discovered (S1). */
export type AgentSource = "global" | "project";

/**
 * Normalized agent definition (S15). Downstream code receives only this shape,
 * never raw frontmatter (S16). `tools` and `skills` normalize omission and
 * `false` to `[]`, accept `true` for every capability available after resource
 * loading, or accept an explicit allow-list; `[]` means none. `disallowedTools` and
 * `disallowedSkills` normalize omission to `[]` and accept lists only, which
 * are subtracted from the resolved allow-set after validation. `extensions`
 * omission and `[]` both load no child extensions while remaining distinct
 * metadata states; `maxTurns` omission adds no extension-defined limit (S11).
 */
export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: true | string[];
  disallowedTools: string[];
  skills: true | string[];
  disallowedSkills: string[];
  extensions?: string[];
  maxTurns?: number;
  enabled: boolean;
  systemPrompt: string;
  source: AgentSource;
  sourcePath: string;
}

// ---- Effective configuration (fixed by T2; shape declared here) ----

/**
 * Effective configuration after defaults, global, and project layers merge.
 * Loading and validation live in `config.ts` (T2); this interface fixes the
 * shape every layer and consumer agrees on.
 */
export interface MinimalSubagentsConfig {
  historyRetentionDays: number;
  defaultModel?: string;
  defaultThinking?: ThinkingLevel;
  maxConcurrentSubagents: number;
  injectGuidelines: boolean;
}

// ---- Service boundaries ----
//
// Narrow interfaces the four tools depend on. Later features (agent registry,
// session runtime, record storage) provide implementations
// and compose them at the entry point. Results stay `unknown` here: each
// owning feature fixes its result contract when it plugs in.

/** Minimal identity projection of a Pi model. Any `Model<any>` satisfies this. */
export interface ParentModelIdentity {
  readonly provider: string;
  readonly id: string;
}

/**
 * Per-call parent context (002 T1/T9): the concrete parent model plus its
 * effective thinking. Supplied by the caller on every new or resume call,
 * never read from globals, so resolution stays explicit.
 */
export interface InvocationParentContext {
  readonly model?: Model<Api>;
  readonly thinking?: ThinkingLevel;
}

export interface SessionCallLifecycle {
  identified(agent: string): void;
}

/** Session runtime boundary (composed by the subagent-runtime feature). */
export interface SessionService {
  call(
    params: SubagentCallParams,
    context?: ExtensionContext,
    lifecycle?: SessionCallLifecycle,
  ): Promise<unknown>;
  output(params: SubagentOutputParams): Promise<unknown>;
  shutdown(context: ExtensionContext): Promise<void>;
}

/** Agent registry boundary (composed by the agent-registry feature). */
export interface AgentRegistryService {
  list(params: SubagentListParams): Promise<unknown>;
}

/** Status boundary (composed from session state). */
export interface StatusService {
  status(params: SubagentStatusParams): Promise<unknown>;
}

/** Services the extension entry point wires into the four tools. */
export interface ToolServices {
  sessions: SessionService;
  registry: AgentRegistryService;
  status: StatusService;
}
