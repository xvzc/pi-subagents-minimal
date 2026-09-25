/**
 * Stable coded errors for pi-subagents-minimal.
 *
 * Public error codes are contracts (S17). Tool-boundary failures serialize to
 * `{ error: { code, message } }` envelopes (S4) and never crash the parent
 * session: unknown failures become `INTERNAL_ERROR` without leaking sensitive
 * details, and envelopes contain only plain strings so they always serialize.
 */

export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "AGENT_NOT_FOUND",
  "MODEL_NOT_FOUND",
  "THINKING_LEVEL_UNSUPPORTED",
  "EXTENSION_LOAD_FAILED",
  "SESSION_NOT_FOUND",
  "SESSION_BUSY",
  "SESSION_NOT_RUNNING",
  "SESSION_NOT_RESUMABLE",
  "INTERNAL_ERROR",
] as const;

/** Stable public error codes (S17). */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** True for one of the stable codes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === "string" &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Failure envelope returned to the model (S4). */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

/** True when `value` has the `{ error: { code, message } }` shape (S4). */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string";
}

/** Coded error thrown inside the extension and serialized at the tool boundary. */
export class MinimalSubagentsError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MinimalSubagentsError";
    this.code = code;
  }

  toEnvelope(): ErrorEnvelope {
    return { error: { code: this.code, message: this.message } };
  }
}

const GENERIC_INTERNAL_MESSAGE = "An unexpected internal error occurred.";

/**
 * Convert any thrown value to a serializable failure envelope.
 * Only explicitly created `MinimalSubagentsError` values keep their code and
 * message. Everything else — unknown `Error` instances, thrown strings,
 * externally shaped envelope-like objects, and all other values — becomes
 * `INTERNAL_ERROR` with a generic message so internal details never leak.
 * Never throws.
 */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  try {
    if (err instanceof MinimalSubagentsError) return err.toEnvelope();
    return {
      error: { code: "INTERNAL_ERROR", message: GENERIC_INTERNAL_MESSAGE },
    };
  } catch {
    return {
      error: { code: "INTERNAL_ERROR", message: GENERIC_INTERNAL_MESSAGE },
    };
  }
}
