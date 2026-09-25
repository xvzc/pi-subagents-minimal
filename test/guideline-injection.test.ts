/**
 * Guideline injection tests (012 S3-S8, A1-A4, A6).
 *
 * Covers the pure append/dedup helper, the parent-only `before_agent_start`
 * handler shape, and conditional activation wiring. The embedded block is
 * asserted through stable boundary/content invariants; these tests never read
 * the external `SYSTEM.md` at runtime.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUIDELINE_BLOCK,
  handleGuidelineInjection,
  injectGuidelinesIntoPrompt,
} from "../src/guidelines.js";
import extension from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

/** Isolated config paths so activation never reads real host/project config. */
function isolatedConfigOptions(): { agentDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-minimal-guidelines-"));
  tempRoots.push(root);
  return { agentDir: join(root, "agent"), cwd: join(root, "work") };
}

type BeforeAgentStartHandler = (event: BeforeAgentStartEvent) => unknown;

async function bootHandlers(options?: {
  agentDir: string;
  cwd: string;
}): Promise<Map<string, BeforeAgentStartHandler>> {
  const handlers = new Map<string, BeforeAgentStartHandler>();
  const pi = {
    registerTool: () => undefined,
    on: (name: string, handler: BeforeAgentStartHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  await extension(pi, undefined, options ?? isolatedConfigOptions());
  return handlers;
}

function startEvent(systemPrompt: string): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "user prompt",
    systemPrompt,
    systemPromptOptions: {},
  } as unknown as BeforeAgentStartEvent;
}

describe("embedded guideline block (S3)", () => {
  it("is bounded by exactly the coordination tags", () => {
    expect(GUIDELINE_BLOCK.startsWith("<agent-coordination>")).toBe(true);
    expect(GUIDELINE_BLOCK.endsWith("</agent-coordination>")).toBe(true);
    expect(GUIDELINE_BLOCK).not.toContain("\r");
  });

  it("carries the current internal sections", () => {
    for (const heading of [
      "## Capability and Dependency Checks",
      "## Bounded Brief Preparation",
      "## Dispatch and Result Collection",
      "## Writer Isolation and Integration",
    ]) {
      expect(GUIDELINE_BLOCK).toContain(heading);
    }
    expect(GUIDELINE_BLOCK).toContain(
      "Apply this section whenever a multi-part task includes delegated work.",
    );
  });
});

describe("injectGuidelinesIntoPrompt (S4, S5, S8)", () => {
  it("turns an empty prompt into exactly the block", () => {
    expect(injectGuidelinesIntoPrompt("")).toBe(GUIDELINE_BLOCK);
  });

  it("appends with exactly two newlines for a non-empty prompt", () => {
    const result = injectGuidelinesIntoPrompt("base prompt");
    expect(result).toBe(`base prompt\n\n${GUIDELINE_BLOCK}`);
  });

  it("uses no leading separator when the prompt is empty", () => {
    const result = injectGuidelinesIntoPrompt("") as string;
    expect(result.startsWith("\n")).toBe(false);
  });

  it("returns no replacement when the exact block is already present", () => {
    for (const prompt of [
      GUIDELINE_BLOCK,
      `before\n\n${GUIDELINE_BLOCK}`,
      `${GUIDELINE_BLOCK}\n\nafter`,
      `before\n\n${GUIDELINE_BLOCK}\n\nafter`,
    ]) {
      expect(injectGuidelinesIntoPrompt(prompt)).toBeUndefined();
    }
  });

  it("still appends when only the marker tags are present", () => {
    const prompt =
      "<agent-coordination>host-provided summary</agent-coordination>";
    const result = injectGuidelinesIntoPrompt(prompt);
    expect(result).toBe(`${prompt}\n\n${GUIDELINE_BLOCK}`);
  });
});

describe("handleGuidelineInjection (S4, S5, S7)", () => {
  it("returns only a systemPrompt replacement when the block is missing", () => {
    const result = handleGuidelineInjection(startEvent("base prompt"));
    expect(result).toEqual({
      systemPrompt: `base prompt\n\n${GUIDELINE_BLOCK}`,
    });
    expect(Object.keys(result as Record<string, unknown>)).toEqual([
      "systemPrompt",
    ]);
  });

  it("returns no replacement when the exact block is present", () => {
    expect(
      handleGuidelineInjection(startEvent(`base\n\n${GUIDELINE_BLOCK}`)),
    ).toBeUndefined();
  });

  it("leaves the user prompt out of the result", () => {
    const result = handleGuidelineInjection(startEvent("")) as
      Record<string, unknown> | undefined;
    expect(result?.systemPrompt).toBe(GUIDELINE_BLOCK);
    expect("prompt" in (result ?? {})).toBe(false);
    expect("message" in (result ?? {})).toBe(false);
  });
});

describe("activation wiring (S4, S6, A1, A2)", () => {
  it("registers the injection handler by default", async () => {
    const handlers = await bootHandlers();
    expect(handlers.has("before_agent_start")).toBe(true);
  });

  it("omits the injection handler when injectGuidelines is false", async () => {
    const paths = isolatedConfigOptions();
    mkdirSync(join(paths.cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(paths.cwd, ".pi", "pi-subagents-minimal.json"),
      JSON.stringify({ injectGuidelines: false }),
      "utf-8",
    );
    const handlers = await bootHandlers(paths);
    expect(handlers.has("before_agent_start")).toBe(false);
  });

  it("appends exactly once through the registered default handler", async () => {
    const handlers = await bootHandlers();
    const handler = handlers.get("before_agent_start")!;
    const result = (await handler(startEvent("base prompt"))) as
      { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toBe(`base prompt\n\n${GUIDELINE_BLOCK}`);
    expect(Object.keys(result ?? {})).toEqual(["systemPrompt"]);
    expect(
      await handler(startEvent(result?.systemPrompt ?? "")),
    ).toBeUndefined();
  });

  it("keeps existing session lifecycle handlers when injection is disabled", async () => {
    const paths = isolatedConfigOptions();
    mkdirSync(join(paths.cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(paths.cwd, ".pi", "pi-subagents-minimal.json"),
      JSON.stringify({ injectGuidelines: false }),
      "utf-8",
    );
    const handlers = await bootHandlers(paths);
    expect(handlers.has("before_agent_start")).toBe(false);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});
