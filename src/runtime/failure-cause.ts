/**
 * Safe classification of child-invocation failure causes.
 *
 * Stored errors and the UI must stay informative without ever persisting
 * provider- or exception-controlled text: credentials, tokens, prompts, URLs,
 * and stack frames can all appear in raw messages. This module inspects
 * candidate text only to select one fixed category and returns constant
 * labels, so the retained cause is bounded, finite, and secret-free. When no
 * category matches, callers keep their generic message.
 */

/** Bounded, finite failure categories; no raw text is retained. */
export const FAILURE_CAUSE_KINDS = [
  "authentication",
  "rate_limit",
  "timeout",
  "network",
  "overloaded",
  "context_length",
  "model_not_found",
  "invalid_request",
  "server_error",
] as const;

export type FailureCauseKind = (typeof FAILURE_CAUSE_KINDS)[number];

/** Fixed safe suffix per category; contains no inspected text. */
const CAUSE_LABELS: Record<FailureCauseKind, string> = {
  authentication: "model request authentication failed",
  rate_limit: "the model request was rate-limited",
  timeout: "the model request timed out",
  network: "a network request failed",
  overloaded: "the model service was overloaded",
  context_length: "the model context window was exceeded",
  model_not_found: "the requested model was not found",
  invalid_request: "the model request was rejected as invalid",
  server_error: "the model service reported an internal error",
};

/**
 * Ordered category matchers. Order is significant: more specific provider
 * signals are checked before more general phrases. Patterns match stable,
 * provider-independent phrasing, not bare status numbers or words like
 * "failed" and "auth" that could appear in unrelated local errors.
 */
const CAUSE_PATTERNS: ReadonlyArray<readonly [FailureCauseKind, RegExp]> = [
  [
    "authentication",
    /\b(?:unauthori[sz]ed|unauthenticated|authentication[_ ](?:failed|error|required)|invalid[_ -]?(?:x[_ -]?)?api[_ -]?key|incorrect api key|no api key|provide (?:an )?api key|api key (?:is )?(?:invalid|missing|not set|not configured)|missing (?:api key|credentials?)|credential[s]? (?:are )?(?:invalid|expired|rejected|missing|not found))\b/i,
  ],
  [
    "rate_limit",
    /\b(?:rate[_ -]?limit(?:ed|ing)?|too many requests|quota (?:exceeded|exhausted)|insufficient_quota)\b/i,
  ],
  [
    "timeout",
    /\b(?:time[ -]?d? ?out|etimedout|deadline exceeded|request took too long)\b/i,
  ],
  [
    "network",
    /\b(?:econnrefused|econnreset|enotfound|eai_again|epipe|ehostunreach|enetunreach|network (?:error|failure|unreachable)|fetch failed|socket hang up|connection (?:refused|reset|closed|error))\b/i,
  ],
  ["overloaded", /\b(?:overloaded|service unavailable)\b/i],
  [
    "context_length",
    /\b(?:context[_ -]?(?:length|window)|maximum context|too many tokens|token limit|prompt is too long)\b/i,
  ],
  [
    "model_not_found",
    /\b(?:model[_ -]?(?:not found|does not exist|unknown|unavailable)|no such model)\b/i,
  ],
  [
    "invalid_request",
    /\b(?:invalid[_ -]?request|bad request|validation (?:error|failed)|malformed (?:request|input|body))\b/i,
  ],
  [
    "server_error",
    /\b(?:internal server error|bad gateway|upstream (?:error|failure))\b/i,
  ],
];

/** Bounded walk depth over `Error.cause` chains; avoids unbounded traversal. */
const MAX_CAUSE_DEPTH = 4;
/** Inspected text is truncated before matching so huge strings cannot stall it. */
const MAX_CAUSE_TEXT = 4096;

/**
 * Candidate cause strings in priority order: the value itself when it is a
 * string, then `message` and one level of `cause` per object, bounded in
 * depth and length. Only string `message`/`cause` fields are read, never
 * stack traces or arbitrary exception properties.
 */
function causeTexts(cause: unknown): string[] {
  const texts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current === "string") {
      texts.push(current.slice(0, MAX_CAUSE_TEXT));
      break;
    }
    if (typeof current !== "object" || current === null) break;
    try {
      const record = current as { message?: unknown; cause?: unknown };
      const message = record.message;
      if (typeof message === "string") {
        texts.push(message.slice(0, MAX_CAUSE_TEXT));
      }
      current = record.cause;
    } catch {
      return [];
    }
  }
  return texts;
}

/**
 * Classify an unknown thrown value or assistant stop error message into one
 * fixed category, or `undefined` when nothing recognizable matches. The
 * inspected text is never returned or persisted.
 */
export function classifyFailureCause(
  cause: unknown,
): FailureCauseKind | undefined {
  for (const text of causeTexts(cause)) {
    for (const [kind, pattern] of CAUSE_PATTERNS) {
      if (pattern.test(text)) return kind;
    }
  }
  return undefined;
}

/**
 * Compose a stored failure message. Assistant-stop errors get fixed model
 * request categories; unknown-origin errors get only neutral network/timeout
 * labels or the unchanged generic message.
 */
export function failureMessage(
  base: string,
  cause: unknown,
  origin: "assistant_stop" | "unknown" = "unknown",
): string {
  const kind = classifyFailureCause(cause);
  if (kind === undefined) return base;
  const label =
    origin === "assistant_stop"
      ? CAUSE_LABELS[kind]
      : kind === "network"
        ? "a network request failed"
        : kind === "timeout"
          ? "a request timed out"
          : undefined;
  if (label === undefined) return base;
  const stem = base.endsWith(".") ? base.slice(0, -1) : base;
  return `${stem}: ${label}.`;
}
