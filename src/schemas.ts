/**
 * Public TypeBox schemas for pi-subagents-minimal.
 *
 * This module owns the four tools' parameter shapes and the shared thinking
 * and error-envelope schemas. Action-specific runtime validation (ranges,
 * resolution, state checks) remains with the owning feature.
 *
 * ID fields are deliberately plain strings, not pattern-constrained: an
 * unknown session ID must fail with the coded `SESSION_NOT_FOUND` envelope
 * at runtime, never as a host-level schema rejection. Domain checks live in
 * `types.ts` (`isSessionId`) and are enforced by owning features.
 */

import { type Static, Type } from "@sinclair/typebox";
import { THINKING_LEVELS } from "./types.js";

// ---- Shared value schemas ----

/** The seven supported thinking names (C5, S16). */
export const ThinkingSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  {
    description:
      "Optional call-level reasoning setting for a new or resumed session. Precedence is activation-loaded agent frontmatter, then this value, config, and current parent. The effective model must support the result. Do not supply this for steer.",
  },
);
export type ThinkingParams = Static<typeof ThinkingSchema>;

/** Shared error detail carried by every failed operation (S4). */
export const ErrorDetailSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
});

/** Failed operations are representable as `{ error: { code, message } }` (S4). */
export const ErrorEnvelopeSchema = Type.Object({
  error: ErrorDetailSchema,
});

// ---- Tool parameter schemas (S1) ----

/** `subagent_call` parameters (input contract detailed by 002-subagent-runtime). */
export const SubagentCallSchema = Type.Object(
  {
    type: Type.Union(
      [Type.Literal("new"), Type.Literal("resume"), Type.Literal("steer")],
      {
        description:
          'Operation to perform. Use "new" for a fresh assignment, "resume" only to continue or correct the same retained live session, and "steer" only for immediate control of a currently running session. New and resume return queued acceptance and continue in the background.',
      },
    ),
    agent: Type.Optional(
      Type.String({
        description:
          'Enabled agent name. Required for "new"; discover valid names with subagent_list. Omit for "resume" and "steer".',
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          'Optional call-level model for a new or resumed session, as a canonical provider/model ID or an unambiguous model ID. Precedence is activation-loaded agent frontmatter, then this value, config, and current parent. Omit for "steer".',
      }),
    ),
    thinking: Type.Optional(ThinkingSchema),
    session_id: Type.Optional(
      Type.String({
        description:
          'Target session ID. Required for "resume" and "steer"; ignored for "new". Use the ID returned by subagent_call or named by a completion signal.',
      }),
    ),
    workspaceDir: Type.Optional(
      Type.String({
        description:
          'Optional existing directory to use as the isolated working directory (cwd) for a new session. Use this only when an isolated workspace is needed, such as for parallel write operations that could otherwise conflict. Tools and file access operate from this directory, while agent configuration, skills, extensions, session storage, namespace, and cleanup remain rooted at the parent cwd. Omit to use the parent cwd. Only valid for type: "new"; "resume" and "steer" reject this field.',
      }),
    ),
    prompt: Type.String({
      description:
        "Instruction, continuation, correction, or steering instruction. Keep it within parent/user authorization, preserve unrelated work, NEVER include secrets.",
    }),
  },
  {
    description:
      "Do not wait or repeatedly poll after new or resume; retrieve the full result with subagent_output when completion is signaled or the result is needed. Start dependent work only after prerequisite output is collected and found sufficient; assess failed or inadequate prerequisites before replanning. Independent work may run in parallel, but keep one writer per workspace unless workspaces are genuinely isolated. Completion delivery is best-effort.",
  },
);
export type SubagentCallParams = Static<typeof SubagentCallSchema>;

/** `subagent_output` parameters (input contract detailed by 002-subagent-runtime). */
export const SubagentOutputSchema = Type.Object(
  {
    session_id: Type.String({
      description:
        "Session ID whose full retained report should be read. Use it after subagent_call accepts a session, when a completion signal names it, or whenever the full result is needed. Reading does not consume the result. Collect required output before claiming completion. A child report or lifecycle summary is not independently verified evidence; acceptance-sensitive claims still require direct inspection or appropriate checks.",
    }),
  },
  {
    description:
      "Returns the retained full report for a session without consuming it. Do not use this to poll for results; completion will be notified automatically.",
  },
);
export type SubagentOutputParams = Static<typeof SubagentOutputSchema>;

/** `subagent_list` takes no parameters (input contract detailed by 001-agent-registry). */
export const SubagentListSchema = Type.Object(
  {},
  {
    description:
      "Takes no parameters. Use before starting bounded work to discover the concise set of enabled agent definitions available for delegation.",
  },
);
export type SubagentListParams = Static<typeof SubagentListSchema>;

/** `subagent_status` takes no parameters (contracts detailed by 002 status portions). */
export const SubagentStatusSchema = Type.Object(
  {},
  {
    description:
      "Returns lifecycle summaries only, not verified evidence or full output. Use subagent_output for the full report after completion notification; do not use this to poll agent status.",
  },
);
export type SubagentStatusParams = Static<typeof SubagentStatusSchema>;
