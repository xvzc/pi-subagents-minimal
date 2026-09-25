/**
 * Filesystem discovery for pi-subagents-minimal (S1, S4).
 *
 * Reads direct `*.md` files from the three explicit agent directories in
 * lexical filename order. Missing directories are silent; directory and file
 * read failures contribute one safe path-specific warning each and never
 * block other files or layers. Each file is passed to the accepted
 * `parseAgentMetadata`; warnings carry fixed reasons only and never expose
 * file contents or invalid values.
 *
 * Reads only the three explicit agent directories. Never reads credentials.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentSource } from "../types.js";
import { type AgentFileWarning, parseAgentMetadata } from "./metadata.js";

/** Path overrides. Production callers omit both so host values apply. */
export interface AgentPathOptions {
  /** Agent directory override; defaults to the Pi host value. */
  agentDir?: string;
  /** Working directory override; defaults to `process.cwd()`. */
  cwd?: string;
}

/** Global Pi agents: `<agent-dir>/agents` (S1). */
export function globalAgentsDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "agents");
}

/** Shared project agents: `<cwd>/.agents/agents` (S1). */
export function sharedProjectAgentsDir(cwd: string = process.cwd()): string {
  return join(cwd, ".agents", "agents");
}

/** Pi project agents: `<cwd>/.pi/agents` (S1). */
export function piProjectAgentsDir(cwd: string = process.cwd()): string {
  return join(cwd, ".pi", "agents");
}

/** Valid definitions found in one directory, in lexical file order. */
export interface AgentLayerScan {
  definitions: AgentDefinition[];
  warnings: AgentFileWarning[];
}

/** Errno code when available; file contents are never included. */
function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Deterministic code-unit order across platforms (S4). */
function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read one agent directory. Only direct `*.md` entries (case-sensitive) are
 * considered, processed in lexical filename order (S4). A missing directory
 * is silent; an unreadable directory contributes one warning and no
 * definitions. An unreadable file contributes one warning and no definition.
 * Same-directory duplicate valid names resolve to the lexically later file
 * with one safe replacement warning.
 */
export function loadAgentLayer(
  directory: string,
  source: AgentSource,
): AgentLayerScan {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return { definitions: [], warnings: [] };
    const code = errnoOf(err);
    return {
      definitions: [],
      warnings: [
        {
          path: directory,
          message: `unreadable directory${code ? ` (${code})` : ""}: skipping agent files in this directory`,
        },
      ],
    };
  }

  const files = entries.filter((name) => name.endsWith(".md")).sort(lexical);

  const definitions: AgentDefinition[] = [];
  const byName = new Map<string, number>();
  const warnings: AgentFileWarning[] = [];

  for (const name of files) {
    const filePath = join(directory, name);
    let text: string;
    try {
      text = readFileSync(filePath, "utf-8");
    } catch (err) {
      const code = errnoOf(err);
      warnings.push({
        path: filePath,
        message: `unreadable file${code ? ` (${code})` : ""}: skipping this agent file`,
      });
      continue;
    }
    const parsed = parseAgentMetadata(text, { source, sourcePath: filePath });
    if (!parsed.ok) {
      warnings.push(parsed.warning);
      continue;
    }
    const existing = byName.get(parsed.definition.name);
    if (existing === undefined) {
      byName.set(parsed.definition.name, definitions.length);
      definitions.push(parsed.definition);
    } else {
      definitions[existing] = parsed.definition;
      warnings.push({
        path: filePath,
        message:
          "duplicate agent name: replacing earlier definition from this directory",
      });
    }
  }

  return { definitions, warnings };
}
