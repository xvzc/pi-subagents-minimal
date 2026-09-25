/**
 * Contained namespace paths for record storage (S1-S3).
 *
 * Layout:
 * `<agent-dir>/subagents-state/<project-key>/<parent-session-id>/{sessions}/<run-id>.json`
 *
 * - The state root is always `<agent-dir>/subagents-state` (C1).
 * - `project-key` is the hex SHA-256 of the lexically canonical project path
 *   (resolved, normalized, no trailing separator). It contains no raw path
 *   characters, so project locations never leak into storage keys (S1).
 * - Canonicalization is lexical only: `.`, `..`, duplicate separators, and
 *   trailing slashes alias to the same key, but symlinks are not resolved.
 *   Callers pass one canonical project path (normally the process working
 *   directory) so the same logical project always maps to one key.
 * - Parent-session IDs use a conservative single-segment format: 1-128
 *   characters of ASCII letters, digits, `_`, and `-`, starting with a letter
 *   or digit. This is intentionally narrower than any Pi host session-ID
 *   format: values with separators, dots, traversal, NUL/control characters,
 *   or other punctuation are rejected rather than interpreted.
 * - Run IDs use the exact lowercase hexadecimal `8-4-4` format from the
 *   shared contracts.
 * - Constructed paths are lexically contained, while filesystem operations also
 *   reject linked/non-directory components inside the state tree and compare
 *   real paths before sensitive I/O (S3, N2). Repeated checks narrow races, but
 *   complete protection from a hostile same-owner process requires openat-style
 *   directory handles that Node does not expose; the storage tree is therefore
 *   an owner-only trust boundary.
 *
 * All helpers take explicit `agentDir` / `projectPath` / `parentSessionId`
 * arguments and read no host state or credentials.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SESSION_ID_PATTERN } from "../types.js";

/** State directory name under `<agent-dir>` (C1). */
export const STATE_DIR_NAME = "subagents-state";

/** File namespace for session records. */
export const SESSIONS_DIR_NAME = "sessions";

/** Record file extension. */
export const RECORD_FILE_EXTENSION = ".json";

/** Hash algorithm used for project keys. */
export const PROJECT_KEY_ALGORITHM = "sha256";

/**
 * Conservative parent-session ID format (see module docs).
 * Single path segment: starts alphanumeric, then letters/digits/`_`/`-`.
 */
export const PARENT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Session run ID: 16 lowercase hexadecimal digits grouped `8-4-4`. */
export const SESSION_RUN_ID_PATTERN = SESSION_ID_PATTERN;

/** Namespace inputs. All values are explicit; nothing is read from the host. */
export interface NamespaceOptions {
  /** Pi agent directory; the state root is derived from it. */
  agentDir: string;
  /** Project path; only its canonical hash enters storage paths. */
  projectPath: string;
  /** Validated parent-session namespace segment. */
  parentSessionId: string;
}

/** Assert `value` is a non-empty string argument. */
function assertPathArgument(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${name}: expected a non-empty string.`);
  }
}

/**
 * Lexically canonical project path: absolute, normalized, no trailing
 * separator. Lexical aliases (`a/../b`, `./b`, `b/`) canonicalize to one path.
 */
export function canonicalizeProjectPath(projectPath: string): string {
  assertPathArgument(projectPath, "project path");
  return resolve(projectPath);
}

/**
 * Stable project key: hex SHA-256 of the canonical project path (S1).
 * The key matches `[0-9a-f]{64}` and contains no raw path segments.
 */
export function projectKeyForProjectPath(projectPath: string): string {
  return createHash(PROJECT_KEY_ALGORITHM)
    .update(canonicalizeProjectPath(projectPath), "utf8")
    .digest("hex");
}

/** State root `<agent-dir>/subagents-state` (C1). */
export function stateRootForAgentDir(agentDir: string): string {
  assertPathArgument(agentDir, "agent directory");
  return join(resolve(agentDir), STATE_DIR_NAME);
}

/**
 * Validate a parent-session namespace segment (S2).
 * Rejects empty values, separators, traversal (`.`, `..`), NUL/controls,
 * and anything outside the conservative format rather than guessing.
 */
export function assertValidParentSessionId(parentSessionId: string): void {
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0) {
    throw new Error("Invalid parent session ID: expected a non-empty string.");
  }
  if (!PARENT_SESSION_ID_PATTERN.test(parentSessionId)) {
    throw new Error(
      "Invalid parent session ID: expected 1-128 characters of letters, digits, " +
        '"_", "-" starting with a letter or digit.',
    );
  }
}

/** Validate a session run ID against the exact shared format. */
export function assertValidSessionRunId(sessionId: string): void {
  if (
    typeof sessionId !== "string" ||
    !SESSION_RUN_ID_PATTERN.test(sessionId)
  ) {
    throw new Error(
      "Invalid session ID: expected 16 lowercase hexadecimal digits grouped 8-4-4.",
    );
  }
}

/**
 * Resolve `candidate` and assert it stays under resolved `root` (S3, N2).
 * Returns the resolved path. Never includes record contents in errors.
 * Exported for retention cleanup, which re-checks containment before every
 * unlink (003 T3).
 */
export function assertContained(
  root: string,
  candidate: string,
  what: string,
): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`Invalid ${what}: path escapes the state root.`);
  }
  return resolved;
}

/** Owner-only mode for every directory in the storage tree (S8, N3). */
export const STORAGE_DIR_MODE = 0o700;

function storageComponents(
  root: string,
  target: string,
  what: string,
): string[] {
  const resolvedRoot = resolve(root);
  const resolvedTarget = assertContained(resolvedRoot, target, what);
  const suffix = relative(resolvedRoot, resolvedTarget);
  const components = [resolvedRoot];
  if (suffix.length > 0) {
    let current = resolvedRoot;
    for (const segment of suffix.split(sep)) {
      current = join(current, segment);
      components.push(current);
    }
  }
  return components;
}

async function hardenDirectory(path: string, what: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `Invalid ${what}: storage path component is not a directory.`,
    );
  }
  if (process.platform !== "win32") await chmod(path, STORAGE_DIR_MODE);
}

/**
 * Verify every component from the state root through `target` without following
 * links, enforce owner-only modes, and establish physical containment.
 */
export async function verifyStorageDirectory(
  root: string,
  target: string,
  what = "storage directory",
): Promise<void> {
  const components = storageComponents(root, target, what);
  for (const component of components) await hardenDirectory(component, what);
  const physicalRoot = await realpath(components[0]);
  const physicalTarget = await realpath(components.at(-1) as string);
  assertContained(physicalRoot, physicalTarget, what);
}

/**
 * Securely establish the state-root-to-target chain. Ancestors outside the
 * configured state root are intentionally not inspected, so a legitimate
 * symlink in an OS/agent-directory ancestor remains supported.
 */
export async function ensureStorageDirectory(
  root: string,
  target: string,
  what = "storage directory",
): Promise<void> {
  const components = storageComponents(root, target, what);
  try {
    await lstat(components[0]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(components[0], { recursive: true, mode: STORAGE_DIR_MODE });
  }
  await hardenDirectory(components[0], what);
  for (const component of components.slice(1)) {
    try {
      await mkdir(component, { mode: STORAGE_DIR_MODE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    await hardenDirectory(component, what);
  }
  await verifyStorageDirectory(root, target, what);
}

/** Reject linked/non-regular leaves and verify their physical containment. */
export async function verifyStorageFile(
  root: string,
  path: string,
  what = "storage file",
): Promise<void> {
  assertContained(root, path, what);
  await verifyStorageDirectory(root, dirname(path), what);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Invalid ${what}: storage leaf is not a regular file.`);
  }
  const physicalRoot = await realpath(root);
  const physicalPath = await realpath(path);
  assertContained(physicalRoot, physicalPath, what);
}

/** Read a contained regular leaf without following a final symlink where supported. */
export async function readStorageFile(
  root: string,
  path: string,
): Promise<string> {
  await verifyStorageFile(root, path, "record file");
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    await verifyStorageDirectory(root, dirname(path), "record file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Unlink a contained regular leaf only after a final repeated physical check. */
export async function unlinkStorageFile(
  root: string,
  path: string,
): Promise<void> {
  await verifyStorageFile(root, path, "record file");
  await verifyStorageDirectory(root, dirname(path), "record file");
  await unlink(path);
}

/**
 * Namespace root `<root>/<project-key>/<parent-session-id>` (C2).
 * Validates the parent session ID before joining, then asserts containment.
 */
export function namespaceRootForParentSession(
  options: NamespaceOptions,
): string {
  assertPathArgument(options.agentDir, "agent directory");
  assertPathArgument(options.projectPath, "project path");
  assertValidParentSessionId(options.parentSessionId);
  const root = stateRootForAgentDir(options.agentDir);
  const candidate = join(
    root,
    projectKeyForProjectPath(options.projectPath),
    options.parentSessionId,
  );
  return assertContained(root, candidate, "parent-session namespace");
}

/** Project records root `<root>/<project-key>` (003 T3, S16).
 * Retention cleanup enumerates every valid parent-session namespace under
 * this directory so abandoned histories can expire. Validates the path
 * arguments before joining, then asserts containment.
 */
export function projectDirForProject(options: {
  agentDir: string;
  projectPath: string;
}): string {
  assertPathArgument(options.agentDir, "agent directory");
  assertPathArgument(options.projectPath, "project path");
  const root = stateRootForAgentDir(options.agentDir);
  const candidate = join(root, projectKeyForProjectPath(options.projectPath));
  return assertContained(root, candidate, "project namespace");
}

/** Directory holding session records for one parent-session namespace. */
export function sessionRecordsDirForParentSession(
  options: NamespaceOptions,
): string {
  const namespaceRoot = namespaceRootForParentSession(options);
  return assertContained(
    stateRootForAgentDir(options.agentDir),
    join(namespaceRoot, SESSIONS_DIR_NAME),
    "session records directory",
  );
}

/**
 * Session record path `<namespace>/sessions/<session-id>.json`.
 * Rejects invalid run IDs before joining, then asserts containment.
 */
export function sessionRecordPath(
  options: NamespaceOptions & { sessionId: string },
): string {
  assertValidSessionRunId(options.sessionId);
  const dir = sessionRecordsDirForParentSession(options);
  return assertContained(
    stateRootForAgentDir(options.agentDir),
    join(dir, `${options.sessionId}${RECORD_FILE_EXTENSION}`),
    "session record path",
  );
}
