/**
 * Versioned stored-record envelopes and snapshot validators (S4-S6).
 *
 * Envelopes separate storage versioning from runtime objects: `{ version: 1,
 * kind: "session", data }`. Only version 1 is accepted; unknown
 * versions are never interpreted (S6). Parse results let the record store
 * distinguish `unknown-version`, `kind-mismatch`, and `invalid-schema` without
 * leaking record contents: failure details name fields and expected shapes but
 * never include payload values such as output, prompts, or errors.
 *
 * Snapshots are plain serializable data aligned with the 002 output and
 * status contracts: required ID, agent, status, and core timestamps, plus
 * typed optional fields for metadata, effective model/thinking, output,
 * error, usage, and progress. Extensible fields use explicit JSON-value
 * boundaries (`StoredMetadata` and additional usage keys): arbitrary objects are
 * never accepted blindly.
 *
 * Persisted values reject: functions, promises/thenables (via the function
 * check on `then`), non-plain objects (class instances such as Date, Map, or
 * host session objects), cycles, non-finite numbers, bigint, symbol, and
 * `undefined` (which JSON drops silently). Additionally, no object at any depth
 * may use a live-handle key (`worker`, `session`, `controller`, `callback`,
 * and common handle aliases) or a precedence-source label (`model_source`,
 * `thinking_source`, and variants): creation-time precedence (002 C1/C2) is
 * evaluated before persistence, so only the effective model/thinking persist
 * (S5, N4). Bare `session`/`handle`-style keys are rejected even with string
 * values; legitimate text belongs in string fields such as `output`.
 *
 * Invariants enforced: envelope `kind` matches the snapshot shape and ID
 * namespace, and active records carry no `completed_at` while terminal records
 * must carry a valid one (000 S6).
 */

import {
  isRunStatus,
  isSessionId,
  isTerminalStatus,
  isThinkingLevel,
  type RunStatus,
  type ThinkingLevel,
} from "../types.js";

/** Only accepted stored-record version (S6). */
export const STORED_RECORD_VERSION = 1;

/** Stored-record kind. Sessions have exactly one file each. */
export type StoredRecordKind = "session";

/** Explicit JSON value boundary for extensible persisted fields. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Explicit JSON object boundary for persisted metadata maps. */
export type StoredMetadata = { [key: string]: JsonValue };

export type StoredErrorDiagnostic =
  | {
      phase: "assistant_stop";
      assistant_turn: number;
      stop_reason: "error";
    }
  | { phase: "prompt_throw" };

/** Serializable failure detail. Diagnostics are optional for record compatibility. */
export type StoredError = {
  code: string;
  message: string;
  diagnostic?: StoredErrorDiagnostic;
};

/**
 * Observed usage counters (002 `subagent_output`). Known counters are
 * non-negative safe integers; additional keys must still be JSON values.
 */
export type StoredUsage = {
  turns?: number;
  tool_uses?: number;
  total_tokens?: number;
};

/**
 * Serializable session snapshot (002 output/status contracts).
 * `created_at` is always present; `completed_at` is present if and only if
 * `status` is terminal. `model`/`thinking` are the effective values.
 */
export type PersistedSessionSnapshot = {
  session_id: string;
  agent: string;
  model: string;
  thinking: ThinkingLevel;
  status: RunStatus;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output?: string;
  error?: StoredError;
  usage?: StoredUsage;
  metadata?: StoredMetadata;
};

/** Versioned session envelope. */
export interface StoredSessionEnvelope {
  version: typeof STORED_RECORD_VERSION;
  kind: "session";
  data: PersistedSessionSnapshot;
}

/** Failure details never include payload values. */
export type EnvelopeParseFailure =
  | { ok: false; reason: "unknown-version"; detail: string }
  | {
      ok: false;
      reason: "kind-mismatch";
      expected: StoredRecordKind;
      detail: string;
    }
  | { ok: false; reason: "invalid-schema"; errors: string[] };

/** Typed session-envelope parse result for the record store. */
export type SessionEnvelopeParseResult =
  { ok: true; envelope: StoredSessionEnvelope } | EnvelopeParseFailure;

/** Snapshot validation result. Errors name fields, never values. */
export type SnapshotValidation<T> =
  { ok: true; snapshot: T } | { ok: false; errors: string[] };

/**
 * Live-handle field names that must never appear in persisted values (S5, N4).
 * Compared case-insensitively against exact keys. `__proto__` is included so
 * prototype-chain payloads cannot smuggle through metadata maps.
 */
const LIVE_HANDLE_KEYS: ReadonlySet<string> = new Set([
  "worker",
  "session",
  "controller",
  "callback",
  "abortcontroller",
  "promise",
  "handle",
  "conversation",
  "timer",
  "socket",
  "stream",
  "filehandle",
  "vmcontext",
  "__proto__",
]);

/**
 * Creation-time precedence-source labels that must never persist (S5).
 * Only effective model/thinking values persist. Compared case-insensitively.
 */
const PRECEDENCE_SOURCE_KEYS: ReadonlySet<string> = new Set([
  "model_source",
  "modelsource",
  "thinking_source",
  "thinkingsource",
  "precedence",
  "precedence_source",
  "precedencesource",
  "resolution_source",
  "resolutionsource",
  "resolved_from",
  "resolvedfrom",
  "source_label",
  "sourcelabel",
]);

/** True for plain JSON-style objects (prototypeless or `Object.prototype`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Assert `value` is safely persistable JSON data.
 * Rejects functions (including `then` callbacks, which also excludes
 * promises/thenables), non-plain objects, cycles, non-finite numbers, bigint,
 * symbol, `undefined`, live-handle keys, and precedence-source labels.
 * Error messages carry field paths and reasons only, never values.
 */
export function assertPersistableValue(value: unknown, label = "value"): void {
  const ancestors = new Set<object>();
  const check = (node: unknown, path: string): void => {
    if (node === null) return;
    switch (typeof node) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(node)) {
          throw new Error(`${path}: non-finite numbers cannot be persisted.`);
        }
        return;
      case "undefined":
        throw new Error(
          `${path}: undefined cannot be persisted; omit the field instead.`,
        );
      case "bigint":
      case "symbol":
      case "function":
        throw new Error(`${path}: ${typeof node} values cannot be persisted.`);
      case "object": {
        if (ancestors.has(node)) {
          throw new Error(`${path}: circular references cannot be persisted.`);
        }
        if (Array.isArray(node)) {
          ancestors.add(node);
          try {
            for (let index = 0; index < node.length; index++) {
              if (!(index in node)) {
                throw new Error(
                  `${path}[${index}]: undefined cannot be persisted; omit the field instead.`,
                );
              }
              check(node[index] as unknown, `${path}[${index}]`);
            }
          } finally {
            ancestors.delete(node);
          }
          return;
        }
        if (!isPlainObject(node)) {
          throw new Error(
            `${path}: only plain objects and arrays can be persisted.`,
          );
        }
        ancestors.add(node);
        try {
          for (const key of Object.keys(node)) {
            const lowered = key.toLowerCase();
            if (LIVE_HANDLE_KEYS.has(lowered)) {
              throw new Error(
                `${path}.${key}: live-handle fields must never be persisted.`,
              );
            }
            if (PRECEDENCE_SOURCE_KEYS.has(lowered)) {
              throw new Error(
                `${path}.${key}: precedence-source labels must never be persisted.`,
              );
            }
            check(node[key], `${path}.${key}`);
          }
        } finally {
          ancestors.delete(node);
        }
        return;
      }
    }
  };
  check(value, label);
}

/** Collect a persistability violation as a schema error, if any. */
function checkPersistable(
  errors: string[],
  value: unknown,
  path: string,
): void {
  try {
    assertPersistableValue(value, path);
  } catch (err) {
    errors.push(
      err instanceof Error
        ? err.message
        : `${path}: value cannot be persisted.`,
    );
  }
}

/** True for a non-empty string (identity fields such as agent/model/name). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True for a parseable timestamp string. Timestamps persist as strings. */
function isTimestampString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Validate the two exact child-execution diagnostic shapes. */
function validateStoredErrorDiagnostic(
  errors: string[],
  value: unknown,
  path: string,
): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected a stored error diagnostic object.`);
    return;
  }
  if (value.phase === "assistant_stop") {
    if (
      typeof value.assistant_turn !== "number" ||
      !Number.isSafeInteger(value.assistant_turn) ||
      value.assistant_turn < 1
    ) {
      errors.push(`${path}.assistant_turn: expected a positive safe integer.`);
    }
    if (value.stop_reason !== "error") {
      errors.push(`${path}.stop_reason: expected "error".`);
    }
    for (const key of Object.keys(value)) {
      if (!["phase", "assistant_turn", "stop_reason"].includes(key)) {
        errors.push(
          `${path}.${key}: unexpected field in stored error diagnostic.`,
        );
      }
    }
    return;
  }
  if (value.phase === "prompt_throw") {
    for (const key of Object.keys(value)) {
      if (key !== "phase") {
        errors.push(
          `${path}.${key}: unexpected field in stored error diagnostic.`,
        );
      }
    }
    return;
  }
  errors.push(`${path}.phase: expected "assistant_stop" or "prompt_throw".`);
}

/** Validate a stored error detail with backward-compatible optional diagnostics. */
function validateStoredError(
  errors: string[],
  value: unknown,
  path: string,
): StoredError | undefined {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected an object with "code" and "message".`);
    return undefined;
  }
  let valid = true;
  if (!isNonEmptyString(value.code)) {
    errors.push(`${path}.code: expected a non-empty string.`);
    valid = false;
  }
  if (!isNonEmptyString(value.message)) {
    errors.push(`${path}.message: expected a non-empty string.`);
    valid = false;
  }
  if (value.diagnostic !== undefined) {
    const priorErrors = errors.length;
    validateStoredErrorDiagnostic(
      errors,
      value.diagnostic,
      `${path}.diagnostic`,
    );
    if (errors.length !== priorErrors) valid = false;
  }
  for (const key of Object.keys(value)) {
    if (key !== "code" && key !== "message" && key !== "diagnostic") {
      errors.push(`${path}.${key}: unexpected field in stored error.`);
      valid = false;
    }
  }
  if (!valid) return undefined;
  return value as StoredError;
}

/** Validate observed usage counters; known fields are non-negative integers. */
function validateStoredUsage(
  errors: string[],
  value: unknown,
  path: string,
): StoredUsage | undefined {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected an object of usage counters.`);
    return undefined;
  }
  let valid = true;
  for (const field of ["turns", "tool_uses", "total_tokens"] as const) {
    const fieldValue: unknown = value[field];
    if (fieldValue !== undefined) {
      if (
        typeof fieldValue !== "number" ||
        !Number.isSafeInteger(fieldValue) ||
        fieldValue < 0
      ) {
        errors.push(`${path}.${field}: expected a non-negative safe integer.`);
        valid = false;
      }
    }
  }
  if (!valid) return undefined;
  return value as StoredUsage;
}

/**
 * Enforce the active-vs-terminal `completed_at` invariant (000 S6):
 * active records carry no `completed_at`; terminal records must carry one.
 */
function validateCompletion(
  errors: string[],
  status: RunStatus,
  completedAt: unknown,
  path: string,
): void {
  if (isTerminalStatus(status)) {
    if (completedAt === undefined) {
      errors.push(`${path}: required for terminal status "${status}".`);
    } else if (!isTimestampString(completedAt)) {
      errors.push(`${path}: expected a parseable timestamp string.`);
    }
  } else if (completedAt !== undefined) {
    errors.push(`${path}: must be absent for active status "${status}".`);
  }
}

/** Validate fields of a session snapshot. */
function validateSnapshotBase(
  errors: string[],
  value: Record<string, unknown>,
): { status: RunStatus; completedAt: unknown } | undefined {
  let valid = true;
  const id: unknown = value.session_id;
  if (!isSessionId(id)) {
    errors.push(
      "session_id: expected 16 lowercase hexadecimal digits grouped 8-4-4.",
    );
    valid = false;
  }
  const status: unknown = value.status;
  if (!isRunStatus(status)) {
    errors.push(
      'status: expected one of "queued", "running", "completed", "failed", "stopped", "aborted".',
    );
    valid = false;
  }
  if (!isTimestampString(value.created_at)) {
    errors.push("created_at: expected a parseable timestamp string.");
    valid = false;
  }
  if (value.started_at !== undefined && !isTimestampString(value.started_at)) {
    errors.push("started_at: expected a parseable timestamp string.");
    valid = false;
  }
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) {
    errors.push("metadata: expected an object of JSON values.");
    valid = false;
  }
  if (!valid || !isRunStatus(status)) return undefined;
  validateCompletion(errors, status, value.completed_at, "completed_at");
  return { status, completedAt: value.completed_at };
}

/**
 * Validate a persisted session snapshot. Returns payload-free errors.
 * Unknown extra keys are allowed only if the whole snapshot passes the
 * persistability scan (no live handles, precedence labels, or non-JSON).
 */
export function validateSessionSnapshot(
  value: unknown,
): SnapshotValidation<PersistedSessionSnapshot> {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["data: expected a session snapshot object."] };
  }
  validateSnapshotBase(errors, value);
  if (!isNonEmptyString(value.agent)) {
    errors.push("agent: expected a non-empty string.");
  }
  if (!isNonEmptyString(value.model)) {
    errors.push("model: expected a non-empty string.");
  }
  if (!isThinkingLevel(value.thinking)) {
    errors.push(
      'thinking: expected one of "off", "minimal", "low", "medium", "high", "xhigh", "max".',
    );
  }
  if (value.output !== undefined && typeof value.output !== "string") {
    errors.push("output: expected a string.");
  }
  if (value.error !== undefined) {
    validateStoredError(errors, value.error, "error");
  }
  if (value.usage !== undefined) {
    validateStoredUsage(errors, value.usage, "usage");
  }
  checkPersistable(errors, value, "data");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, snapshot: value as PersistedSessionSnapshot };
}

/** Payload-free description of a stored version slot. Scalars pass through; structured values become type tags. */
function describeVersion(version: unknown): string {
  if (version === null || version === undefined)
    return "missing record version";
  switch (typeof version) {
    case "number":
    case "string":
    case "boolean":
      return `unsupported record version ${String(version)}`;
    case "bigint":
    case "symbol":
      return `unsupported record version (${typeof version})`;
    default:
      return `unsupported record version of type ${Array.isArray(version) ? "array" : typeof version}`;
  }
}

/** Payload-free description of a stored kind slot. */
function describeKindMismatch(
  kind: unknown,
  expected: StoredRecordKind,
): string {
  if (typeof kind === "string") {
    return `expected kind "${expected}" but found kind "${kind}"`;
  }
  if (kind === null || kind === undefined)
    return `expected kind "${expected}" but found no kind`;
  return `expected kind "${expected}" but found kind of type ${Array.isArray(kind) ? "array" : typeof kind}`;
}

/** Shared envelope header check: plain object, supported version, expected kind. */
function checkEnvelopeHeader(
  value: unknown,
  expected: StoredRecordKind,
): { ok: true; data: unknown } | EnvelopeParseFailure {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      reason: "invalid-schema",
      errors: ["envelope: expected a record object."],
    };
  }
  if (value.version !== STORED_RECORD_VERSION) {
    return {
      ok: false,
      reason: "unknown-version",
      detail: describeVersion(value.version),
    };
  }
  const extraKeys = Object.keys(value).filter(
    (key) => key !== "version" && key !== "kind" && key !== "data",
  );
  if (value.kind !== expected) {
    return {
      ok: false,
      reason: "kind-mismatch",
      expected,
      detail: describeKindMismatch(value.kind, expected),
    };
  }
  if (extraKeys.length > 0) {
    return {
      ok: false,
      reason: "invalid-schema",
      errors: extraKeys.map(
        (key) => `envelope.${key}: unexpected field in record envelope.`,
      ),
    };
  }
  return { ok: true, data: value.data };
}

/**
 * Parse an unknown value as a stored session envelope.
 * Unknown versions are never interpreted; kind mismatches and schema
 * violations report payload-free reasons for the record store.
 */
export function parseSessionEnvelope(
  value: unknown,
): SessionEnvelopeParseResult {
  const header = checkEnvelopeHeader(value, "session");
  if (!header.ok) return header;
  const validated = validateSessionSnapshot(header.data);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid-schema",
      errors: validated.errors.map((error) =>
        error.startsWith("data") || error.startsWith("envelope")
          ? error
          : `data.${error}`,
      ),
    };
  }
  return {
    ok: true,
    envelope: {
      version: STORED_RECORD_VERSION,
      kind: "session",
      data: validated.snapshot,
    },
  };
}
