/**
 * Stored-schema tests (S4-S6): valid session envelopes, unknown
 * versions (never interpreted), kind mismatches, kind/ID matches, status and
 * timestamp invariants, unsafe/non-JSON/live values, precedence-source
 * exclusion, and payload-free diagnostics.
 */

import { describe, expect, it } from "vitest";
import {
  assertPersistableValue,
  parseSessionEnvelope,
  STORED_RECORD_VERSION,
  validateSessionSnapshot,
} from "../src/storage/schemas.js";

const CREATED = "2026-09-21T00:00:00.000Z";
const COMPLETED = "2026-09-21T01:00:00.000Z";

function validSessionData() {
  return {
    session_id: "00000000-0000-0009",
    agent: "coder",
    model: "pi-model",
    thinking: "medium",
    status: "running",
    created_at: CREATED,
    started_at: CREATED,
    output: "partial output",
    usage: { turns: 1, tool_uses: 2, total_tokens: 100 },
    metadata: { attempt: 1, tags: ["a", "b"] },
  };
}

describe("valid envelopes", () => {
  it("accepts a valid active session envelope", () => {
    const parsed = parseSessionEnvelope({
      version: 1,
      kind: "session",
      data: validSessionData(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope).toEqual({
      version: STORED_RECORD_VERSION,
      kind: "session",
      data: validSessionData(),
    });
  });

  it("accepts minimal queued sessions", () => {
    const parsed = parseSessionEnvelope({
      version: 1,
      kind: "session",
      data: {
        session_id: "00000000-0000-002e",
        agent: "coder",
        model: "m",
        thinking: "off",
        status: "queued",
        created_at: CREATED,
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it("accepts old errors and exact child diagnostic shapes", () => {
    const data = {
      session_id: "00000000-0000-002e",
      agent: "coder",
      model: "m",
      thinking: "off",
      status: "failed",
      created_at: CREATED,
      completed_at: COMPLETED,
    };
    expect(
      parseSessionEnvelope({
        version: 1,
        kind: "session",
        data: {
          ...data,
          error: { code: "CHILD_EXECUTION_FAILED", message: "failed" },
        },
      }).ok,
    ).toBe(true);
    expect(
      parseSessionEnvelope({
        version: 1,
        kind: "session",
        data: {
          ...data,
          error: {
            code: "CHILD_EXECUTION_FAILED",
            message: "failed",
            diagnostic: {
              phase: "assistant_stop",
              assistant_turn: 2,
              stop_reason: "error",
            },
          },
        },
      }).ok,
    ).toBe(true);
  });
});

describe("versions and kinds", () => {
  it("never interprets unknown versions", () => {
    for (const version of [0, 2, "1", null, undefined, {}, [1]]) {
      const session = parseSessionEnvelope({
        version,
        kind: "session",
        data: validSessionData(),
      });
      expect(session.ok).toBe(false);
      if (session.ok) continue;
      expect(session.reason).toBe("unknown-version");
    }
  });

  it("rejects kind mismatches without interpreting data", () => {
    const foreignKind = parseSessionEnvelope({
      version: 1,
      kind: "workflow",
      data: validSessionData(),
    });
    expect(foreignKind.ok).toBe(false);
    if (foreignKind.ok || foreignKind.reason !== "kind-mismatch") {
      expect.unreachable("expected a kind-mismatch failure");
      return;
    }
    expect(foreignKind.expected).toBe("session");
  });

  it("rejects missing kinds and envelope extras", () => {
    const missing = parseSessionEnvelope({
      version: 1,
      data: validSessionData(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.reason === "kind-mismatch") {
      expect(missing.expected).toBe("session");
    } else {
      expect.unreachable("expected a kind-mismatch failure");
    }
    const extra = parseSessionEnvelope({
      version: 1,
      kind: "session",
      data: validSessionData(),
      extra: true,
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok && extra.reason === "invalid-schema") {
      expect(extra.errors.join(" ")).toContain("envelope.extra");
    } else {
      expect.unreachable("expected an invalid-schema failure");
    }
  });

  it("rejects non-session and legacy IDs", () => {
    for (const sessionId of ["wf_notasession", "ses_legacy"]) {
      const parsed = parseSessionEnvelope({
        version: 1,
        kind: "session",
        data: { ...validSessionData(), session_id: sessionId },
      });
      expect(parsed.ok, sessionId).toBe(false);
    }
  });
});

describe("status and timestamps", () => {
  it("rejects unknown statuses", () => {
    const parsed = parseSessionEnvelope({
      version: 1,
      kind: "session",
      data: { ...validSessionData(), status: "done" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.reason === "invalid-schema") {
      expect(parsed.errors.join(" ")).toContain("status");
    } else {
      expect.unreachable("expected an invalid-schema failure");
    }
  });

  it("requires completed_at exactly for terminal records", () => {
    const activeWithCompleted = parseSessionEnvelope({
      version: 1,
      kind: "session",
      data: { ...validSessionData(), completed_at: COMPLETED },
    });
    expect(activeWithCompleted.ok).toBe(false);

    for (const status of ["completed", "failed", "stopped", "aborted"]) {
      const missing = parseSessionEnvelope({
        version: 1,
        kind: "session",
        data: { ...validSessionData(), status },
      });
      expect(missing.ok, status).toBe(false);
      const present = parseSessionEnvelope({
        version: 1,
        kind: "session",
        data: { ...validSessionData(), status, completed_at: COMPLETED },
      });
      expect(present.ok, status).toBe(true);
    }
  });

  it("rejects malformed timestamps", () => {
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        created_at: "not-a-date",
      }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({ ...validSessionData(), started_at: 123 }).ok,
    ).toBe(false);
  });
});

describe("unsafe and non-JSON values", () => {
  it("rejects functions, undefined, symbols, bigints, and non-finite numbers", () => {
    expect(() =>
      assertPersistableValue({ metadata: { fn: () => {} } }, "data"),
    ).toThrow(/function/);
    expect(() => assertPersistableValue({ a: undefined }, "data")).toThrow(
      /undefined/,
    );
    expect(() => assertPersistableValue({ a: Symbol("s") }, "data")).toThrow(
      /symbol/,
    );
    expect(() => assertPersistableValue({ a: BigInt(1) }, "data")).toThrow(
      /bigint/,
    );
    expect(() => assertPersistableValue({ a: Number.NaN }, "data")).toThrow(
      /non-finite/,
    );
    expect(() =>
      assertPersistableValue({ a: Number.POSITIVE_INFINITY }, "data"),
    ).toThrow(/non-finite/);
    // Intentionally asserts thenables are rejected.
    expect(() => assertPersistableValue({ then: () => {} }, "data")).toThrow();
  });

  it("rejects cycles, holes, and non-plain objects", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertPersistableValue(cycle, "data")).toThrow(/circular/);
    const nested: Record<string, unknown> = { a: { b: {} } };
    ((nested.a as Record<string, unknown>).b as Record<string, unknown>).root =
      nested;
    expect(() => assertPersistableValue(nested, "data")).toThrow(/circular/);
    expect(() => assertPersistableValue(new Date(), "data")).toThrow(/plain/);
    expect(() => assertPersistableValue(new Map(), "data")).toThrow(/plain/);
    expect(() => assertPersistableValue(new Array(1), "data")).toThrow(
      /undefined/,
    );
    class Custom {
      value = 1;
    }
    expect(() => assertPersistableValue(new Custom(), "data")).toThrow(/plain/);
  });

  it("rejects non-serializable snapshot fields as invalid schemas", () => {
    expect(
      validateSessionSnapshot({ ...validSessionData(), output: () => "x" }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        metadata: { nested: { deep: [1, Number.NaN] } },
      }).ok,
    ).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(
      validateSessionSnapshot({ ...validSessionData(), metadata: cycle }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        metadata: { run: () => 1 },
      }).ok,
    ).toBe(false);
  });
});

describe("live handles and precedence sources", () => {
  it("rejects live-handle fields at any depth", () => {
    for (const metadata of [
      { worker: { pid: 1 } },
      { callback: "done" },
      { session: "00000000-0000-002b" },
      { controller: { aborted: false } },
      { nested: { promise: { state: "pending" } } },
      { nested: { list: [{ handle: 7 }] } },
    ]) {
      expect(
        validateSessionSnapshot({ ...validSessionData(), metadata }).ok,
      ).toBe(false);
      expect(() => assertPersistableValue(metadata, "data")).toThrow(
        /live-handle/,
      );
    }
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        metadata: { worker: "w" },
      }).ok,
    ).toBe(false);
  });

  it("rejects precedence-source labels instead of persisting them", () => {
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        model_source: "invocation",
      }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        metadata: { thinkingSource: "parent" },
      }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        usage: { turns: 1, precedence: "config" },
      }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        metadata: { resolution_source: "direct" },
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed error and usage shapes", () => {
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        error: { code: "", message: "x" },
      }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({
        ...validSessionData(),
        error: { code: "E", message: "m", extra: 1 },
      }).ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({ ...validSessionData(), usage: { turns: -1 } })
        .ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({ ...validSessionData(), usage: { turns: 1.5 } })
        .ok,
    ).toBe(false);
    expect(
      validateSessionSnapshot({ ...validSessionData(), usage: [1] }).ok,
    ).toBe(false);
    for (const diagnostic of [
      { phase: "assistant_stop", assistant_turn: 0, stop_reason: "error" },
      { phase: "assistant_stop", assistant_turn: 1, stop_reason: "   " },
      {
        phase: "assistant_stop",
        assistant_turn: 1,
        stop_reason: "error",
        raw_stop_reason: "provider_error",
      },
      { phase: "assistant_stop" },
      { phase: "prompt_throw", message: "provider error" },
    ]) {
      expect(
        validateSessionSnapshot({
          ...validSessionData(),
          error: { code: "E", message: "m", diagnostic },
        }).ok,
      ).toBe(false);
    }
  });
});

describe("payload-free diagnostics", () => {
  const SECRET = "SECRET-OUTPUT-9f2c41";

  it("never leaks payloads in envelope failures", () => {
    const invalid = parseSessionEnvelope({
      version: 1,
      kind: "session",
      data: { ...validSessionData(), status: "bogus", output: SECRET },
    });
    expect(invalid.ok).toBe(false);
    expect(JSON.stringify(invalid)).not.toContain(SECRET);

    const unknownVersion = parseSessionEnvelope({
      version: 99,
      kind: "session",
      data: { ...validSessionData(), output: SECRET },
    });
    expect(unknownVersion.ok).toBe(false);
    expect(JSON.stringify(unknownVersion)).not.toContain(SECRET);

    const mismatch = parseSessionEnvelope({
      version: 1,
      kind: "workflow",
      data: { ...validSessionData(), output: SECRET },
    });
    expect(mismatch.ok).toBe(false);
    expect(JSON.stringify(mismatch)).not.toContain(SECRET);
  });

  it("never leaks payloads in snapshot validation errors", () => {
    const validated = validateSessionSnapshot({
      ...validSessionData(),
      status: "bogus",
      output: SECRET,
    });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.errors.join("\n")).not.toContain(SECRET);
    }
    const invalidSnapshot = validateSessionSnapshot({
      ...validSessionData(),
      status: "bogus",
      metadata: { secret: SECRET },
    });
    expect(invalidSnapshot.ok).toBe(false);
    if (!invalidSnapshot.ok) {
      expect(invalidSnapshot.errors.join("\n")).not.toContain(SECRET);
    }
  });
});
