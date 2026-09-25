/**
 * Agent registry precedence for pi-subagents-minimal (S1-S4, S15-S16).
 *
 * Combines the three discovery layers in increasing precedence — global Pi
 * agents, shared project agents, then Pi project agents — so a
 * higher-precedence valid definition replaces a lower-precedence definition
 * with the same case-sensitive name (S2). Both project layers normalize to
 * `source: "project"`; global uses `source: "global"`. No embedded
 * definitions are added; an empty registry is valid (S3).
 *
 * A valid `enabled: false` definition participates in precedence and remains
 * authoritative (D3); filtering happens only in the selectable/list views.
 * An invalid higher-precedence file contributes its warning and never erases
 * a valid lower definition. Only normalized `AgentDefinition` values leave
 * this module — raw frontmatter is never cached or returned (S16).
 *
 * A bound registry captures one normalized snapshot at construction. List,
 * new-session lookup, and retained-session metadata lookup share it until the
 * extension is reactivated and constructs a fresh registry (D4).
 */

import type {
  AgentDefinition,
  AgentRegistryService,
  AgentSource,
  ThinkingLevel,
} from "../types.js";
import {
  type AgentPathOptions,
  globalAgentsDir,
  loadAgentLayer,
  piProjectAgentsDir,
  sharedProjectAgentsDir,
} from "./loader.js";
import type { AgentFileWarning } from "./metadata.js";

/** Path overrides. Production callers omit both so host values apply. */
export type AgentRegistryOptions = AgentPathOptions;

/**
 * Fresh registry state: precedence-resolved definitions (including disabled
 * overrides, sorted by name) plus deterministic warnings in discovery order
 * (global, then shared-project, then Pi-project; lexical within a layer).
 */
export interface AgentRegistrySnapshot {
  definitions: AgentDefinition[];
  warnings: AgentFileWarning[];
}

/** List view: enabled definitions plus the snapshot warnings. */
export interface AgentListCandidates {
  definitions: AgentDefinition[];
  warnings: AgentFileWarning[];
}

/**
 * Public `subagent_list` summary (001 S17-S18). Contains exactly the
 * model-facing fields: name, description, optional model/thinking/
 * extensions/max_turns, required normalized capability policies, and source.
 * `true` stays literal and is never expanded to runtime catalogs. Never
 * carries enabled, systemPrompt, sourcePath, raw frontmatter, or unknown keys.
 */
export interface AgentSummary {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: true | string[];
  disallowed_tools: string[];
  skills: true | string[];
  disallowed_skills: string[];
  extensions?: string[];
  max_turns?: number;
  source: AgentSource;
}

/** Public `subagent_list` warning: path and fixed reason only. */
export interface AgentListWarning {
  path: string;
  message: string;
}

/**
 * Public `subagent_list` result. `warnings` is present only when at least
 * one diagnostic exists; an empty agents array is valid (S3, A1).
 */
export interface AgentListResult {
  agents: AgentSummary[];
  warnings?: AgentListWarning[];
}

/**
 * Map one normalized definition to its public summary. Capability policies
 * are always present in normalized configured form: `true` stays literal,
 * arrays are copied. Normalized `maxTurns` becomes public `max_turns`.
 */
export function toAgentSummary(definition: AgentDefinition): AgentSummary {
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(definition.thinking !== undefined
      ? { thinking: definition.thinking }
      : {}),
    tools: definition.tools === true ? true : [...definition.tools],
    disallowed_tools: [...definition.disallowedTools],
    skills: definition.skills === true ? true : [...definition.skills],
    disallowed_skills: [...definition.disallowedSkills],
    ...(definition.extensions !== undefined
      ? { extensions: [...definition.extensions] }
      : {}),
    ...(definition.maxTurns !== undefined
      ? { max_turns: definition.maxTurns }
      : {}),
    source: definition.source,
  };
}

/**
 * Build the public list result from enabled candidates. Candidates are
 * already precedence-resolved and sorted by name; warnings are copied as
 * `{ path, message }` pairs and omitted entirely when empty.
 */
export function buildAgentListResult(
  candidates: AgentListCandidates,
): AgentListResult {
  const agents = candidates.definitions.map(toAgentSummary);
  if (candidates.warnings.length === 0) return { agents };
  return {
    agents,
    warnings: candidates.warnings.map((warning) => ({
      path: warning.path,
      message: warning.message,
    })),
  };
}

/** Deterministic code-unit order across platforms. */
function byName(a: AgentDefinition, b: AgentDefinition): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Reload all three layers from disk and merge by precedence. Higher layers
 * silently replace lower definitions with the same case-sensitive name;
 * same-directory duplicates already warned inside the loader.
 */
export function loadAgentRegistry(
  options: AgentRegistryOptions = {},
): AgentRegistrySnapshot {
  const layers = [
    { dir: globalAgentsDir(options.agentDir), source: "global" as const },
    { dir: sharedProjectAgentsDir(options.cwd), source: "project" as const },
    { dir: piProjectAgentsDir(options.cwd), source: "project" as const },
  ];
  const merged = new Map<string, AgentDefinition>();
  const warnings: AgentFileWarning[] = [];
  for (const layer of layers) {
    const scan = loadAgentLayer(layer.dir, layer.source);
    warnings.push(...scan.warnings);
    for (const definition of scan.definitions) {
      merged.set(definition.name, definition);
    }
  }
  return {
    definitions: [...merged.values()].sort(byName),
    warnings,
  };
}

/**
 * Selectable view of a snapshot: enabled definitions only, still sorted by
 * name. Disabled overrides stay in the snapshot but never appear here (S15).
 */
export function getSelectableDefinitions(
  snapshot: AgentRegistrySnapshot,
): AgentDefinition[] {
  return snapshot.definitions.filter((definition) => definition.enabled);
}

/**
 * New-session lookup against a snapshot: exact case-sensitive name match
 * among enabled definitions only. Unknown or disabled names resolve to
 * `undefined` so the session runtime can fail with `AGENT_NOT_FOUND`.
 */
export function findAgentForSession(
  snapshot: AgentRegistrySnapshot,
  name: string,
): AgentDefinition | undefined {
  const found = snapshot.definitions.find(
    (definition) => definition.name === name,
  );
  return found?.enabled ? found : undefined;
}

/** Copy normalized metadata so callers cannot mutate the captured snapshot. */
function copyDefinition(definition: AgentDefinition): AgentDefinition {
  return {
    ...definition,
    tools: definition.tools === true ? true : [...definition.tools],
    disallowedTools: [...definition.disallowedTools],
    skills: definition.skills === true ? true : [...definition.skills],
    disallowedSkills: [...definition.disallowedSkills],
    ...(definition.extensions !== undefined
      ? { extensions: [...definition.extensions] }
      : {}),
  };
}

/** Copy a captured registry snapshot for public inspection. */
function copySnapshot(snapshot: AgentRegistrySnapshot): AgentRegistrySnapshot {
  return {
    definitions: snapshot.definitions.map(copyDefinition),
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
  };
}

/**
 * Activation-scoped registry. Construction loads and normalizes the filesystem
 * once; all operations query that captured snapshot until a new registry is
 * constructed by extension reactivation. New-session lookup filters disabled
 * definitions; retained-session lookup does not.
 */
export function createAgentRegistry(options: AgentRegistryOptions = {}): {
  snapshot(): AgentRegistrySnapshot;
  listCandidates(): AgentListCandidates;
  findForSession(name: string): AgentDefinition | undefined;
  findCurrent(name: string): AgentDefinition | undefined;
} {
  const captured = loadAgentRegistry(options);
  return {
    snapshot(): AgentRegistrySnapshot {
      return copySnapshot(captured);
    },
    listCandidates(): AgentListCandidates {
      return {
        definitions: getSelectableDefinitions(captured).map(copyDefinition),
        warnings: captured.warnings.map((warning) => ({ ...warning })),
      };
    },
    findForSession(name: string): AgentDefinition | undefined {
      const definition = findAgentForSession(captured, name);
      return definition === undefined ? undefined : copyDefinition(definition);
    },
    findCurrent(name: string): AgentDefinition | undefined {
      const definition = captured.definitions.find(
        (candidate) => candidate.name === name,
      );
      return definition === undefined ? undefined : copyDefinition(definition);
    },
  };
}

/**
 * Default `AgentRegistryService` for normal extension activation. Each
 * `list` call maps the bound activation snapshot through `listCandidates`
 * to the public `{ agents, warnings? }` contract.
 */
export function createRegistryService(
  options: AgentRegistryOptions = {},
  registry = createAgentRegistry(options),
): AgentRegistryService {
  return {
    async list() {
      return buildAgentListResult(registry.listCandidates());
    },
  };
}
