/**
 * Shared-contract tests (A5): session ID format (S2), run states (S5, S6),
 * thinking levels (C5), stable error codes (S17), and error envelopes (S4).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  type ErrorCode,
  isErrorCode,
  isErrorEnvelope,
  MinimalSubagentsError,
  toErrorEnvelope,
} from "../src/errors.js";
import extension, { createTools } from "../src/index.js";
import { ErrorEnvelopeSchema, ThinkingSchema } from "../src/schemas.js";
import {
  assertSessionId,
  createSessionId,
  isRunStatus,
  isSessionId,
  isTerminalStatus,
  isThinkingLevel,
  RUN_STATUSES,
  type RunStatus,
  THINKING_LEVELS,
} from "../src/types.js";

describe("session IDs", () => {
  it("accepts exactly lowercase hexadecimal 8-4-4 IDs", () => {
    for (const id of [
      "00000000-0000-0000",
      "ffffffff-ffff-ffff",
      "a1b2c3d4-e5f6-0718",
    ]) {
      expect(isSessionId(id), id).toBe(true);
      expect(() => assertSessionId(id), id).not.toThrow();
    }
  });

  it("rejects malformed and legacy IDs without guessing", () => {
    for (const id of [
      "A1b2c3d4-e5f6-0718",
      "a1b2c3d4-e5f6-071",
      "a1b2c3d4-e5f6-07180",
      "a1b2c3d4e5f60718",
      "a1b2c3d4-e5f6-0718-1234",
      "g1b2c3d4-e5f6-0718",
      "ses_a1b2c3d4-e5f6-0718",
      "../a1b2c3d4-e5f6-0718",
      "",
    ]) {
      expect(isSessionId(id), id).toBe(false);
      expect(() => assertSessionId(id), id).toThrow();
    }
    expect(isSessionId(undefined)).toBe(false);
    expect(isSessionId(null)).toBe(false);
    expect(isSessionId(42)).toBe(false);
    expect(isSessionId({})).toBe(false);
  });

  it("formats exactly eight random bytes without reducing the value space", () => {
    const random = (size: number) => {
      expect(size).toBe(8);
      return Uint8Array.from([0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18]);
    };
    expect(createSessionId(random)).toBe("a1b2c3d4-e5f6-0718");
  });
});

describe("run states", () => {
  it("defines exactly the six run states (S5)", () => {
    expect(RUN_STATUSES).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
      "stopped",
      "aborted",
    ]);
    const states: RunStatus[] = [
      "queued",
      "running",
      "completed",
      "failed",
      "stopped",
      "aborted",
    ];
    for (const state of states) expect(isRunStatus(state)).toBe(true);
    expect(isRunStatus("done")).toBe(false);
    expect(isRunStatus("")).toBe(false);
    expect(isRunStatus(undefined)).toBe(false);
  });

  it("partitions active and terminal states (S6)", () => {
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
    for (const terminal of [
      "completed",
      "failed",
      "stopped",
      "aborted",
    ] as const) {
      expect(isTerminalStatus(terminal)).toBe(true);
    }
  });
});

describe("thinking levels", () => {
  it("supports exactly the seven specified names (C5)", () => {
    expect(THINKING_LEVELS).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(isThinkingLevel("low")).toBe(true);
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel(undefined)).toBe(false);
  });

  it("validates thinking values through the public schema", () => {
    expect(Value.Check(ThinkingSchema, "medium")).toBe(true);
    expect(Value.Check(ThinkingSchema, "ultra")).toBe(false);
    expect(Value.Check(ThinkingSchema, undefined)).toBe(false);
  });
});

describe("stable errors", () => {
  it("defines exactly the ten S17 codes", () => {
    const expected: ErrorCode[] = [
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
    ];
    expect([...ERROR_CODES].sort()).toEqual([...expected].sort());
    expect(new Set(ERROR_CODES).size).toBe(10);
    expect(isErrorCode("SESSION_NOT_FOUND")).toBe(true);
    expect(isErrorCode("SESSION_ID_IGNORED")).toBe(false);
    expect(isErrorCode("")).toBe(false);
  });

  it("serializes coded errors to envelopes without crashing", () => {
    const err = new MinimalSubagentsError(
      "SESSION_NOT_FOUND",
      "No such session.",
    );
    expect(err.toEnvelope()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "No such session." },
    });
    expect(toErrorEnvelope(err)).toEqual(err.toEnvelope());
    expect(isErrorEnvelope(toErrorEnvelope(err))).toBe(true);
    expect(Value.Check(ErrorEnvelopeSchema, toErrorEnvelope(err))).toBe(true);
  });

  it("converts unknown failures to INTERNAL_ERROR without leaking details", () => {
    const sensitiveError = new Error("secret db password hunter2");
    const sensitiveString = "secret token abc123";
    expect(toErrorEnvelope(sensitiveError)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred.",
      },
    });
    expect(toErrorEnvelope(sensitiveString)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred.",
      },
    });
    expect(JSON.stringify(toErrorEnvelope(sensitiveError))).not.toContain(
      "hunter2",
    );
    expect(JSON.stringify(toErrorEnvelope(sensitiveString))).not.toContain(
      "abc123",
    );
    const untrustedEnvelope = {
      error: {
        code: "SESSION_NOT_FOUND",
        message: "externally shaped secret leak",
      },
    };
    expect(toErrorEnvelope(untrustedEnvelope)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred.",
      },
    });
    for (const thrown of [
      null,
      undefined,
      42,
      true,
      Symbol("x"),
      BigInt(7),
    ] as const) {
      const envelope = toErrorEnvelope(thrown);
      expect(envelope.error.code).toBe("INTERNAL_ERROR");
      expect(envelope.error.message).toBe(
        "An unexpected internal error occurred.",
      );
      expect(isErrorEnvelope(envelope)).toBe(true);
      expect(Value.Check(ErrorEnvelopeSchema, envelope)).toBe(true);
    }
  });

  it("handles circular thrown values without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const envelope = toErrorEnvelope(circular);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
    expect(() => JSON.stringify(envelope)).not.toThrow();
    expect(Value.Check(ErrorEnvelopeSchema, envelope)).toBe(true);
  });
});

describe("tool-boundary serialization", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop() as string, { recursive: true, force: true });
    }
  });

  /** Isolated config paths so activation never reads real host/project config. */
  function isolatedConfigOptions(): { agentDir: string; cwd: string } {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-minimal-contracts-"));
    tempRoots.push(root);
    return { agentDir: join(root, "agent"), cwd: join(root, "work") };
  }

  async function firstTool(): Promise<ToolDefinition<any, any, any>> {
    const tools: ToolDefinition<any, any, any>[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition<any, any, any>) => {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;
    await extension(
      pi,
      {
        sessions: {
          call: async () => {
            const circular: Record<string, unknown> = {};
            circular.self = circular;
            return circular;
          },
          output: async () => {
            throw "unserializable-shaped string failure";
          },
          shutdown: async () => undefined,
        },
      },
      isolatedConfigOptions(),
    );
    const tool = tools.find((candidate) => candidate.name === "subagent_call");
    expect(tool).toBeDefined();
    return tool!;
  }

  it("converts non-serializable payloads to INTERNAL_ERROR envelopes", async () => {
    const tool = await firstTool();
    const result = await tool.execute(
      "call-1",
      { type: "new" },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    const body = JSON.parse(text);
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: expect.any(String) },
    });
    expect(Value.Check(ErrorEnvelopeSchema, body)).toBe(true);
  });

  it("converts non-Error service throws to INTERNAL_ERROR envelopes", async () => {
    const tools = createTools({
      sessions: {
        call: async () => ({}),
        output: async () => {
          throw "unserializable-shaped string failure";
        },
        shutdown: async () => undefined,
      },
    });
    const output = tools.find((tool) => tool.name === "subagent_output")!;
    const result = await output.execute(
      "call-2",
      { session_id: "00000000-0000-0065" },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred.",
      },
    });
    expect(text).not.toContain("unserializable-shaped string failure");
  });
});
