/** Shared model/thinking resolution tests for new and resume calls. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MinimalSubagentsError } from "../src/errors.js";
import {
  type InvocationResolverInput,
  resolveInvocationModelThinking,
} from "../src/runtime/invocation-resolver.js";
import type { ThinkingLevel } from "../src/types.js";

function fakeModel(
  provider: string,
  id: string,
  options: {
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  } = {},
): Model<Api> {
  return {
    provider,
    id,
    reasoning: options.reasoning ?? true,
    ...(options.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: options.thinkingLevelMap }
      : {}),
  } as unknown as Model<Api>;
}

const catalog: Model<Api>[] = [
  fakeModel("acme", "codex", {
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  }),
  fakeModel("acme", "standard"),
  fakeModel("other", "codex"),
  fakeModel("basic", "plain", { reasoning: false }),
];
const parentAcmeStandard = catalog[1]!;
const parentBasicPlain = catalog[3]!;

function resolve(overrides: Partial<InvocationResolverInput> = {}) {
  return resolveInvocationModelThinking({ catalog, ...overrides });
}

function resolveCode(overrides: Partial<InvocationResolverInput> = {}): string {
  try {
    resolve(overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(MinimalSubagentsError);
    return (error as MinimalSubagentsError).code;
  }
  throw new Error("expected resolveInvocationModelThinking to throw");
}

describe("model precedence (agent -> call -> config -> parent)", () => {
  it("prefers agent frontmatter over every lower layer", () => {
    expect(
      resolve({
        agent: { model: "acme/codex", thinking: "off" },
        invocationModel: "basic/plain",
        config: { defaultModel: "acme/standard" },
        parent: { model: parentBasicPlain, thinking: "high" },
      }).model,
    ).toBe("acme/codex");
  });

  it("prefers call parameters over config and parent", () => {
    expect(
      resolve({
        invocationModel: "basic/plain",
        invocationThinking: "off",
        config: { defaultModel: "acme/standard" },
        parent: { model: parentAcmeStandard, thinking: "high" },
      }).model,
    ).toBe("basic/plain");
  });

  it("prefers config over parent and otherwise inherits parent", () => {
    expect(
      resolve({
        config: { defaultModel: "acme/codex", defaultThinking: "low" },
        parent: { model: parentAcmeStandard, thinking: "high" },
      }).model,
    ).toBe("acme/codex");
    expect(
      resolve({ parent: { model: parentAcmeStandard, thinking: "medium" } }),
    ).toEqual({ model: "acme/standard", thinking: "medium" });
  });

  it("treats a supplied blank call model as authoritative only when agent model is absent", () => {
    expect(
      resolve({
        agent: { model: "acme/standard", thinking: "low" },
        invocationModel: "   ",
      }).model,
    ).toBe("acme/standard");
    expect(
      resolveCode({
        invocationModel: "   ",
        config: { defaultModel: "acme/standard", defaultThinking: "low" },
      }),
    ).toBe("MODEL_NOT_FOUND");
  });

  it("continues past normalized blank agent and config references", () => {
    expect(
      resolve({
        agent: { model: "" },
        config: { defaultModel: "  " },
        parent: { model: parentAcmeStandard, thinking: "low" },
      }).model,
    ).toBe("acme/standard");
  });

  it("returns MODEL_NOT_FOUND when every model layer is absent", () => {
    expect(resolveCode({ config: { defaultThinking: "off" } })).toBe(
      "MODEL_NOT_FOUND",
    );
  });
});

describe("thinking precedence (agent -> call -> config -> parent)", () => {
  const modelInput = { invocationModel: "acme/standard" };

  it("prefers agent frontmatter over every lower layer", () => {
    expect(
      resolve({
        ...modelInput,
        agent: { thinking: "high" },
        invocationThinking: "low",
        config: { defaultThinking: "medium" },
        parent: { thinking: "minimal" },
      }).thinking,
    ).toBe("high");
  });

  it("prefers call over config and parent", () => {
    expect(
      resolve({
        ...modelInput,
        invocationThinking: "low",
        config: { defaultThinking: "medium" },
        parent: { thinking: "high" },
      }).thinking,
    ).toBe("low");
  });

  it("prefers config over parent and otherwise inherits parent", () => {
    expect(
      resolve({
        ...modelInput,
        config: { defaultThinking: "medium" },
        parent: { thinking: "high" },
      }).thinking,
    ).toBe("medium");
    expect(
      resolve({ ...modelInput, parent: { thinking: "minimal" } }).thinking,
    ).toBe("minimal");
  });

  it("returns INVALID_ARGUMENT when every thinking layer is absent", () => {
    expect(resolveCode({ invocationModel: "acme/standard" })).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("resolves model and thinking independently across layers", () => {
    expect(
      resolve({
        agent: { thinking: "off" },
        invocationModel: "basic/plain",
        config: { defaultModel: "acme/standard", defaultThinking: "high" },
        parent: { model: parentAcmeStandard, thinking: "medium" },
      }),
    ).toEqual({ model: "basic/plain", thinking: "off" });
  });
});

describe("identity and capability validation", () => {
  it("resolves canonical and unique bare references to canonical IDs", () => {
    expect(
      resolve({ invocationModel: "acme/codex", invocationThinking: "low" })
        .model,
    ).toBe("acme/codex");
    expect(
      resolve({ invocationModel: "standard", invocationThinking: "low" }).model,
    ).toBe("acme/standard");
  });

  it("rejects ambiguous and unknown model references", () => {
    expect(
      resolveCode({ invocationModel: "codex", invocationThinking: "off" }),
    ).toBe("MODEL_NOT_FOUND");
    expect(
      resolveCode({ invocationModel: "missing", invocationThinking: "off" }),
    ).toBe("MODEL_NOT_FOUND");
  });

  it("uses the concrete parent model without catalog lookup", () => {
    expect(
      resolve({
        parent: { model: fakeModel("ghost", "model"), thinking: "off" },
      }),
    ).toEqual({ model: "ghost/model", thinking: "off" });
  });

  it("rejects unsupported agent, call, and config thinking", () => {
    expect(
      resolveCode({
        agent: { thinking: "high" },
        invocationModel: "basic/plain",
        invocationThinking: "off",
      }),
    ).toBe("THINKING_LEVEL_UNSUPPORTED");
    expect(
      resolveCode({
        invocationModel: "basic/plain",
        invocationThinking: "high",
      }),
    ).toBe("THINKING_LEVEL_UNSUPPORTED");
    expect(
      resolveCode({
        invocationModel: "basic/plain",
        config: { defaultThinking: "low" },
      }),
    ).toBe("THINKING_LEVEL_UNSUPPORTED");
  });

  it("clamps only parent-inherited thinking", () => {
    expect(
      resolve({
        invocationModel: "basic/plain",
        parent: { model: parentAcmeStandard, thinking: "high" },
      }),
    ).toEqual({ model: "basic/plain", thinking: "off" });
    expect(
      resolve({ parent: { model: parentAcmeStandard, thinking: "max" } })
        .thinking,
    ).toBe("high");
  });

  it("supports xhigh and max only when reported by the model", () => {
    expect(
      resolveCode({
        invocationModel: "acme/standard",
        invocationThinking: "xhigh",
      }),
    ).toBe("THINKING_LEVEL_UNSUPPORTED");
    expect(
      resolve({ invocationModel: "acme/codex", invocationThinking: "max" })
        .thinking,
    ).toBe("max");
  });

  it("returns effective values without source labels", () => {
    expect(
      Object.keys(
        resolve({
          invocationModel: "acme/standard",
          invocationThinking: "low",
        }),
      ).sort(),
    ).toEqual(["model", "thinking"]);
  });
});

describe("shared new/resume policy", () => {
  it("is deterministic for the same four current layers", () => {
    const input: InvocationResolverInput = {
      agent: { model: "acme/codex", thinking: "high" },
      invocationModel: "basic/plain",
      invocationThinking: "off",
      config: { defaultModel: "acme/standard", defaultThinking: "medium" },
      parent: { model: parentBasicPlain, thinking: "minimal" },
      catalog,
    };
    expect(resolveInvocationModelThinking(input)).toEqual({
      model: "acme/codex",
      thinking: "high",
    });
  });

  it("uses strict explicit thinking but clamps inherited parent thinking", () => {
    const level: ThinkingLevel = "high";
    expect(
      resolve({
        invocationModel: "acme/standard",
        invocationThinking: level,
        parent: { thinking: "minimal" },
      }).thinking,
    ).toBe("high");
  });
});
