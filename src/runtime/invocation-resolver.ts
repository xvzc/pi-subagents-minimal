/**
 * T1 invocation resolution for 002-subagent-runtime (S15-S20).
 *
 * One pure resolver shared by `subagent_call(type: "new")` and retained
 * `resume` resolution (D1). Model and thinking resolve independently using
 * agent metadata -> invocation -> config -> current parent precedence (C1, C2).
 * Every input arrives per call — resolved agent
 * definition, effective config slice, parent model/thinking, and Pi's full
 * model catalog — so nothing is read from global activation state.
 *
 * Model identity uses the full Pi catalog (the `ModelRegistry.getAll`
 * view), never authenticated availability; authentication failures stay
 * child-execution failures for T2. References are trimmed, then matched
 * exactly: either canonical `provider/modelId` or a bare model id that
 * matches exactly one catalog model. Zero or multiple matches fail with
 * `MODEL_NOT_FOUND` before any child session is created.
 *
 * Thinking from metadata, invocation, or config is deliberate and fails
 * with `THINKING_LEVEL_UNSUPPORTED` when the resolved model does not report
 * it. Only parent-inherited thinking is clamped with
 * Pi's official model-aware helper. Supported levels come from Pi's
 * official `getSupportedThinkingLevels`, so non-reasoning models report
 * only `off` and `xhigh`/`max` succeed only when the model reports them.
 */

import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { MinimalSubagentsError } from "../errors.js";
import type {
  AgentDefinition,
  InvocationParentContext,
  MinimalSubagentsConfig,
  ParentModelIdentity,
  ThinkingLevel,
} from "../types.js";

/**
 * Everything the resolver needs for one new or resume call. `agent` is the
 * current precedence-resolved definition (new requires it to be enabled;
 * resume may use a disabled retained definition); `config` is the effective-config slice;
 * `catalog` is Pi's full model catalog for identity lookup.
 */
export interface InvocationResolverInput {
  readonly invocationModel?: string;
  readonly invocationThinking?: ThinkingLevel;
  readonly agent?: Pick<AgentDefinition, "model" | "thinking">;
  readonly config?: Pick<
    MinimalSubagentsConfig,
    "defaultModel" | "defaultThinking"
  >;
  readonly parent?: InvocationParentContext;
  readonly catalog: readonly Model<Api>[];
}

/** Effective values only: canonical model plus thinking (D4). No source labels. */
export interface ResolvedInvocation {
  /** Canonical `provider/modelId` identity. Persist and return this form. */
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

/** Canonical `provider/modelId` form for a catalog or parent model. */
function toCanonicalModelId(model: ParentModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Exact model-reference match over the full catalog.
 *
 * Mirrors the exact semantics of Pi's `findExactModelReferenceMatch`
 * (canonical `provider/modelId`, then `provider`/`id` split, then a bare id
 * matching exactly one model; zero or multiple matches miss), reimplemented
 * locally because that helper is not exported from the installed
 * `pi-coding-agent` package index and its deep module path is not covered
 * by the package's export map. References are pre-trimmed; a supplied blank
 * invocation reference deliberately reaches lookup and does not fall through.
 */
function findExactModelReferenceMatch(
  reference: string,
  catalog: readonly Model<Api>[],
): Model<Api> | undefined {
  if (reference === "") return undefined;
  const normalized = reference.toLowerCase();
  const canonical = catalog.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;
  const slashIndex = reference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = reference.substring(0, slashIndex).trim();
    const modelId = reference.substring(slashIndex + 1).trim();
    if (provider !== "" && modelId !== "") {
      const scoped = catalog.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (scoped.length === 1) return scoped[0];
      if (scoped.length > 1) return undefined;
    }
  }
  const bare = catalog.filter((model) => model.id.toLowerCase() === normalized);
  return bare.length === 1 ? bare[0] : undefined;
}

/** Upstream-normalized metadata/config blanks remain absent. */
function cleanFallbackReference(
  reference: string | undefined,
): string | undefined {
  if (reference === undefined) return undefined;
  const trimmed = reference.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve effective model and thinking for one new or resume call.
 * Throws a coded validation error before child allocation or retained-child
 * mutation. Never touches authentication state.
 */
export function resolveInvocationModelThinking(
  input: InvocationResolverInput,
): ResolvedInvocation {
  const reference =
    cleanFallbackReference(input.agent?.model) ??
    (input.invocationModel !== undefined
      ? input.invocationModel.trim()
      : cleanFallbackReference(input.config?.defaultModel));

  let model: Model<Api> | undefined;
  if (reference !== undefined) {
    const match = findExactModelReferenceMatch(reference, input.catalog);
    if (match === undefined) {
      throw new MinimalSubagentsError(
        "MODEL_NOT_FOUND",
        `Unknown model "${reference}".`,
      );
    }
    model = match;
  } else {
    model = input.parent?.model;
  }
  if (model === undefined) {
    throw new MinimalSubagentsError(
      "MODEL_NOT_FOUND",
      "No model was specified and the parent session has no model.",
    );
  }

  const explicitThinking =
    input.agent?.thinking ??
    input.invocationThinking ??
    input.config?.defaultThinking;
  const requestedThinking = explicitThinking ?? input.parent?.thinking;
  if (requestedThinking === undefined) {
    throw new MinimalSubagentsError(
      "INVALID_ARGUMENT",
      "No thinking level was specified by the agent, call, config, or parent session.",
    );
  }
  if (getSupportedThinkingLevels(model).includes(requestedThinking)) {
    return { model: toCanonicalModelId(model), thinking: requestedThinking };
  }
  if (explicitThinking !== undefined) {
    throw new MinimalSubagentsError(
      "THINKING_LEVEL_UNSUPPORTED",
      `Thinking level "${requestedThinking}" is not supported by model "${toCanonicalModelId(model)}".`,
    );
  }
  return {
    model: toCanonicalModelId(model),
    thinking: clampThinkingLevel(model, requestedThinking),
  };
}
