/**
 * Strict agent-file metadata parsing for pi-subagents-minimal (S5-S16).
 *
 * Each Markdown file carries YAML frontmatter plus a non-empty Markdown body.
 * Known fields are fail-closed per file (N1, D1): missing required fields,
 * invalid known-field values, missing frontmatter, or an empty body reject
 * the whole file with exactly one path-specific warning and never partially
 * apply it (S13, S14). Unknown keys are silently ignored without warnings
 * (S13, D1). Model availability is not validated here.
 *
 * Warning hygiene follows the config loader precedent: reasons are fixed
 * strings identifying path, field, and expectation. YAML diagnostics can echo
 * file contents, so they are never forwarded into warnings.
 */

import { parse as parseYaml } from "yaml";
import {
  type AgentDefinition,
  type AgentSource,
  isThinkingLevel,
} from "../types.js";
import { normalizeExtensionSource } from "./extensions.js";

/** Identity of the file being parsed; supplied by the discovery layer (T2). */
export interface AgentFileRef {
  /** Discovery layer the file belongs to (S1). */
  source: AgentSource;
  /** Filesystem path used for warnings and traceability (N2). */
  sourcePath: string;
}

/** Path-specific diagnostic for one rejected file (S14, N2). */
export interface AgentFileWarning {
  path: string;
  message: string;
}

/** Outcome of parsing one agent file: a definition or exactly one warning. */
export type ParseAgentMetadataResult =
  | { ok: true; definition: AgentDefinition }
  | { ok: false; warning: AgentFileWarning };

/** `name` is 1-64 chars and starts alphanumerically (S6). */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `description` upper bound after trimming (S7). */
const DESCRIPTION_MAX_LENGTH = 512;

/** `max_turns` inclusive bounds (S11). */
const MAX_TURNS_MIN = 1;
const MAX_TURNS_MAX = 10000;

/** Frontmatter delimiter: `---` with optional trailing whitespace. */
const DELIMITER_PATTERN = /^---[ \t]*$/;

/** True for a parsed YAML mapping root; arrays and scalars are rejected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one known field only when it is an own property of the frontmatter
 * mapping. Inherited properties (for example via `__proto__`) count as
 * absent, so prototype members can never satisfy required fields.
 */
function ownField(raw: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

/**
 * Parse one allow field (`tools`, `skills`). Omission and `false` normalize
 * to `[]`; `true` means every capability available after resource loading;
 * otherwise an array of unique trimmed non-empty strings. Quoted `"*"` is an
 * ordinary literal name with no wildcard meaning. Returns `undefined` when
 * the field is present but invalid (scalars other than booleans, non-string
 * or blank or duplicate entries).
 */
function parseAllowPolicy(
  raw: Record<string, unknown>,
  key: string,
): true | string[] | undefined {
  const value = ownField(raw, key);
  if (value === undefined || value === false) return [];
  if (value === true) return true;
  if (!Array.isArray(value)) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return undefined;
    }
    const name = entry.trim();
    if (seen.has(name)) return undefined;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

/**
 * Parse one deny field (`disallowed_tools`, `disallowed_skills`). Omission
 * normalizes to `[]`; only arrays of unique trimmed non-empty strings are
 * accepted. Returns `undefined` when the field is present but invalid.
 */
function parseDenyList(
  raw: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = ownField(raw, key);
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return undefined;
    }
    const name = entry.trim();
    if (seen.has(name)) return undefined;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function fail(ref: AgentFileRef, message: string): ParseAgentMetadataResult {
  return { ok: false, warning: { path: ref.sourcePath, message } };
}

/**
 * Split content into frontmatter YAML text and Markdown body.
 * Returns `undefined` when the opening or closing `---` delimiter is absent.
 * The opening delimiter must be the first line; a byte-order mark and
 * CRLF/CR line endings are accepted.
 */
function splitFrontmatter(
  content: string,
): { yamlText: string; body: string } | undefined {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r\n|\r|\n/);
  if (lines.length === 0 || !DELIMITER_PATTERN.test(lines[0] ?? "")) {
    return undefined;
  }
  const closing = lines.findIndex(
    (line, index) => index > 0 && DELIMITER_PATTERN.test(line),
  );
  if (closing < 0) return undefined;
  return {
    yamlText: lines.slice(1, closing).join("\n"),
    body: lines.slice(closing + 1).join("\n"),
  };
}

/**
 * Parse and normalize one agent file into an `AgentDefinition`.
 * Unknown frontmatter keys are silently ignored. Any failure yields exactly
 * one warning whose message carries a fixed reason only — never file
 * contents, body text, or invalid values.
 */
export function parseAgentMetadata(
  content: string,
  ref: AgentFileRef,
): ParseAgentMetadataResult {
  const split = splitFrontmatter(content);
  if (!split) {
    return fail(
      ref,
      "missing frontmatter: expected YAML frontmatter delimited by --- lines",
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(split.yamlText);
  } catch {
    return fail(ref, "invalid frontmatter: expected valid YAML");
  }
  if (raw === undefined || raw === null) {
    return fail(ref, 'missing required field "name"');
  }
  if (!isRecord(raw)) {
    return fail(ref, "invalid frontmatter: expected a YAML mapping");
  }

  const name = ownField(raw, "name");
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return fail(
      ref,
      'invalid "name": expected 1-64 characters matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
    );
  }

  const descriptionRaw = ownField(raw, "description");
  if (typeof descriptionRaw !== "string") {
    return fail(
      ref,
      'invalid "description": expected a non-empty string of at most 512 characters',
    );
  }
  const description = descriptionRaw.trim();
  if (description.length === 0 || description.length > DESCRIPTION_MAX_LENGTH) {
    return fail(
      ref,
      'invalid "description": expected a non-empty string of at most 512 characters',
    );
  }

  const modelRaw = ownField(raw, "model");
  let model: string | undefined;
  if (modelRaw !== undefined) {
    if (typeof modelRaw !== "string" || modelRaw.trim().length === 0) {
      return fail(ref, 'invalid "model": expected a non-empty string');
    }
    model = modelRaw.trim();
  }

  const thinkingRaw = ownField(raw, "thinking");
  let thinking: AgentDefinition["thinking"];
  if (thinkingRaw !== undefined) {
    if (!isThinkingLevel(thinkingRaw)) {
      return fail(
        ref,
        'invalid "thinking": expected one of off, minimal, low, medium, high, xhigh, max',
      );
    }
    thinking = thinkingRaw;
  }

  const tools = parseAllowPolicy(raw, "tools");
  if (tools === undefined) {
    return fail(
      ref,
      'invalid "tools": expected a boolean or an array of unique non-empty strings',
    );
  }

  const skills = parseAllowPolicy(raw, "skills");
  if (skills === undefined) {
    return fail(
      ref,
      'invalid "skills": expected a boolean or an array of unique non-empty strings',
    );
  }

  const disallowedTools = parseDenyList(raw, "disallowed_tools");
  if (disallowedTools === undefined) {
    return fail(
      ref,
      'invalid "disallowed_tools": expected an array of unique non-empty strings',
    );
  }

  const disallowedSkills = parseDenyList(raw, "disallowed_skills");
  if (disallowedSkills === undefined) {
    return fail(
      ref,
      'invalid "disallowed_skills": expected an array of unique non-empty strings',
    );
  }

  const extensionsRaw = ownField(raw, "extensions");
  let extensions: string[] | undefined;
  if (extensionsRaw !== undefined) {
    if (!Array.isArray(extensionsRaw)) {
      return fail(
        ref,
        'invalid "extensions": expected an array of unique npm: or path: sources',
      );
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of extensionsRaw) {
      const source = normalizeExtensionSource(entry);
      if (source === undefined || seen.has(source)) {
        return fail(
          ref,
          'invalid "extensions": expected an array of unique npm: or path: sources',
        );
      }
      seen.add(source);
      normalized.push(source);
    }
    extensions = normalized;
  }

  const maxTurnsRaw = ownField(raw, "max_turns");
  let maxTurns: number | undefined;
  if (maxTurnsRaw !== undefined) {
    if (
      typeof maxTurnsRaw !== "number" ||
      !Number.isSafeInteger(maxTurnsRaw) ||
      maxTurnsRaw < MAX_TURNS_MIN ||
      maxTurnsRaw > MAX_TURNS_MAX
    ) {
      return fail(ref, 'invalid "max_turns": expected a safe integer 1-10000');
    }
    maxTurns = maxTurnsRaw;
  }

  const enabledRaw = ownField(raw, "enabled");
  let enabled = true;
  if (enabledRaw !== undefined) {
    if (typeof enabledRaw !== "boolean") {
      return fail(ref, 'invalid "enabled": expected a boolean');
    }
    enabled = enabledRaw;
  }

  const systemPrompt = split.body.replace(/\r\n?/g, "\n").trim();
  if (systemPrompt.length === 0) {
    return fail(ref, "empty body: expected a non-empty Markdown system prompt");
  }

  return {
    ok: true,
    definition: {
      name,
      description,
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      tools,
      disallowedTools,
      skills,
      disallowedSkills,
      ...(extensions !== undefined ? { extensions } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      enabled,
      systemPrompt,
      source: ref.source,
      sourcePath: ref.sourcePath,
    },
  };
}
