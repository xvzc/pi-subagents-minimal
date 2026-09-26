/**
 * Tool guidance stays out of top-level descriptions. Tool descriptions are
 * concise capability summaries; operation and usage guidance lives on the
 * parameter schemas that own it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension, * as indexModule from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

/** Isolated config paths so activation never reads real host/project config. */
function isolatedConfigOptions(): { agentDir: string; cwd: string } {
  const root = mkdtempSync(
    join(tmpdir(), "pi-subagents-minimal-descriptions-"),
  );
  tempRoots.push(root);
  return { agentDir: join(root, "agent"), cwd: join(root, "work") };
}

type Handler = (event: any, context: ExtensionContext) => unknown;
type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
};

async function bootWithHandlers(): Promise<{
  tools: ToolDefinition<any, any, any>[];
  handlers: Map<string, Handler[]>;
}> {
  const tools: ToolDefinition<any, any, any>[] = [];
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => {
      tools.push(tool);
    },
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  await extension(pi, undefined, isolatedConfigOptions());
  return { tools, handlers };
}

function toolOf(
  tools: ToolDefinition<any, any, any>[],
  name: string,
): ToolDefinition<any, any, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `${name} is registered`).toBeDefined();
  return tool as ToolDefinition<any, any, any>;
}

function schemaOf(
  tools: ToolDefinition<any, any, any>[],
  name: string,
): JsonSchema {
  return toolOf(tools, name).parameters as JsonSchema;
}

function propertyDescription(schema: JsonSchema, name: string): string {
  const description = schema.properties?.[name]?.description;
  expect(description, `${name} has schema guidance`).toBeTypeOf("string");
  expect(description?.trim().length).toBeGreaterThan(0);
  return description as string;
}

describe("tool descriptions", () => {
  it("keeps top-level descriptions to capability summaries", async () => {
    const { tools } = await bootWithHandlers();
    expect(tools.map((tool) => tool.name)).toEqual([
      "subagent_call",
      "subagent_output",
      "subagent_list",
      "subagent_status",
    ]);
    expect(tools.map((tool) => tool.description)).toEqual([
      "Start, resume, or steer a subagent session within the current task's authorized scope.",
      "Read the observed output of a subagent session after its completion notification has been received. Do not use this tool to wait for or poll a running subagent.",
      "List the enabled subagent roles available for delegation.",
      "Show the status of active and recent subagent sessions.",
    ]);
    for (const tool of tools) {
      expect(tool.description).not.toContain("\n");
    }
  });

  it("puts operation-specific call usage on the owning parameters", async () => {
    const { tools } = await bootWithHandlers();
    const schema = schemaOf(tools, "subagent_call");
    const type = propertyDescription(schema, "type");
    expect(type).toContain('"new" for a fresh assignment');
    expect(type).toContain('"resume" only to continue or correct');
    expect(type).toContain('"steer" only for immediate control');
    expect(type).toContain("return queued acceptance");

    expect(propertyDescription(schema, "agent")).toContain(
      'Required for "new"',
    );
    expect(propertyDescription(schema, "agent")).toContain("subagent_list");
    expect(propertyDescription(schema, "model")).toContain(
      "new or resumed session",
    );
    expect(propertyDescription(schema, "model")).toContain(
      "agent frontmatter, then this value, config, and current parent",
    );
    expect(propertyDescription(schema, "model")).toContain('Omit for "steer"');
    expect(propertyDescription(schema, "thinking")).toContain(
      "new or resumed session",
    );
    expect(propertyDescription(schema, "thinking")).toContain(
      "agent frontmatter, then this value, config, and current parent",
    );
    expect(propertyDescription(schema, "thinking")).toContain(
      "Do not supply this for steer",
    );
    expect(propertyDescription(schema, "session_id")).toContain(
      'Required for "resume" and "steer"',
    );
    expect(propertyDescription(schema, "prompt")).toContain(
      "parent/user authorization",
    );
  });

  it("keeps cross-parameter call workflow guidance on the call schema", async () => {
    const { tools } = await bootWithHandlers();
    const description = schemaOf(tools, "subagent_call").description;
    expect(description).toContain("Do not wait or repeatedly poll");
    expect(description).toContain("subagent_output");
    expect(description).toContain(
      "dependent work only after prerequisite output",
    );
    expect(description).toContain("Independent work may run in parallel");
    expect(description).toContain("one writer per workspace");
    expect(description).toContain("best-effort");
  });

  it("puts output retrieval and evidence guidance on session_id", async () => {
    const { tools } = await bootWithHandlers();
    const description = propertyDescription(
      schemaOf(tools, "subagent_output"),
      "session_id",
    );
    expect(description).toContain("completion signal");
    expect(description).toContain("does not consume");
    expect(description).toContain("before claiming completion");
    expect(description).toContain("not independently verified evidence");
    expect(description).toContain("direct inspection or appropriate checks");
  });

  it("uses schema descriptions for parameterless list and status guidance", async () => {
    const { tools } = await bootWithHandlers();
    const list = schemaOf(tools, "subagent_list");
    const status = schemaOf(tools, "subagent_status");
    expect(list.properties).toEqual({});
    expect(list.description).toContain("Takes no parameters");
    expect(list.description).toContain("enabled agent definitions");
    expect(status.properties).toEqual({});
    expect(status.description).toContain("lifecycle summaries only");
    expect(status.description).toContain("not verified evidence");
    expect(status.description).toContain("subagent_output");
  });

  it("carries no prompt append metadata or description constants", async () => {
    const { tools } = await bootWithHandlers();
    for (const tool of tools) {
      expect(tool).not.toHaveProperty("promptGuidelines");
      expect(tool).not.toHaveProperty("promptSnippet");
    }
    for (const name of [
      "SUBAGENT_CALL_GUIDELINES",
      "SUBAGENT_OUTPUT_GUIDELINES",
      "SUBAGENT_STATUS_GUIDELINES",
      "SUBAGENT_LIST_GUIDELINES",
      "SUBAGENT_CALL_DESCRIPTION",
      "SUBAGENT_OUTPUT_DESCRIPTION",
      "SUBAGENT_STATUS_DESCRIPTION",
      "SUBAGENT_LIST_DESCRIPTION",
    ]) {
      expect(indexModule as Record<string, unknown>).not.toHaveProperty(name);
    }
  });

  it("registers one before_agent_start handler and keeps existing handlers", async () => {
    const { tools, handlers } = await bootWithHandlers();
    expect(tools).toHaveLength(4);
    expect(handlers.get("before_agent_start")).toHaveLength(1);
    expect(handlers.get("session_start")).toHaveLength(1);
    expect(handlers.get("input")).toHaveLength(1);
    expect(handlers.get("session_shutdown")).toHaveLength(1);
  });
});
