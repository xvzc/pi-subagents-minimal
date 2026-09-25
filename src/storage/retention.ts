/**
 * Project-wide retention cleanup (003 T3, S13-S18).
 *
 * A terminal record expires when `nowMs - Date.parse(completed_at)` reaches
 * `historyRetentionDays * 24h`, checked with the exact boundary: `>=` deletes
 * (S13). `queued`/`running` records are exempt regardless of age (S14), as are
 * records whose completion lies in the future. Cleanup scans the session
 * directory of every valid parent-session namespace under the
 * active project-key directory — not only the current parent session — so
 * abandoned histories can expire (S16).
 *
 * Read-only eligibility: candidate files are read and validated without ever
 * calling the `RecordStore` loaders, which would normalize active records to
 * aborted. Active records are therefore never rewritten here. Corrupt,
 * unknown-version, kind-mismatched, schema-invalid, filename/data-ID
 * mismatched, unreadable, and future-timestamp records are preserved with
 * fixed path-only warnings that never carry parser text, payloads, or values
 * (S11). Only direct lowercase `.json` children are inspected; temp files,
 * unknown files, invalid namespaces, and unrelated entries are left alone.
 *
 * Deletion: only validated, contained `.json` records proven terminal and
 * expired are unlinked. Eligibility and file identity are re-read under the
 * shared per-record in-process lock immediately before the containment check
 * and unlink. A failed unlink warns and leaves the target intact. A missing
 * project namespace is silent.
 *
 * Lifecycle (S15): {@link cleanupOnActivation} runs during extension
 * activation and {@link cleanupAfterTerminalSettlement} runs after a session
 * manager has successfully persisted a terminal record. Both are
 * thin delegates over {@link cleanupProjectHistory} with the immutable
 * effective config and an explicit clock. Host composition of the
 * terminal-settlement hook belongs to the 002 manager: it must
 * call {@link cleanupAfterTerminalSettlement} only after its terminal write
 * succeeded. This module implements no session runtime behavior.
 */

import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  isTerminalStatus,
  type MinimalSubagentsConfig,
  type RunStatus,
} from "../types.js";
import {
  assertContained,
  assertValidParentSessionId,
  projectDirForProject,
  RECORD_FILE_EXTENSION,
  readStorageFile,
  SESSIONS_DIR_NAME,
  stateRootForAgentDir,
  unlinkStorageFile,
  verifyStorageDirectory,
} from "./paths.js";
import { parseSessionEnvelope } from "./schemas.js";
import { withRecordStorageLock } from "./storage-coordinator.js";

/** Milliseconds in one retention day. */
export const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** Fixed path-only diagnostics for retention cleanup (S11). */
export const RETENTION_WARNINGS = {
  unreadable: "Skipped unreadable record during retention cleanup.",
  invalid: "Skipped invalid record during retention cleanup.",
  futureTimestamp:
    "Skipped record with a future completion timestamp during retention cleanup.",
  deleteFailed: "Expired record could not be deleted during retention cleanup.",
  directoryUnreadable:
    "Skipped unreadable records directory during retention cleanup.",
} as const;

/** Fixed aggregate diagnostic for a cleanup result containing path-only warnings. */
export const RETENTION_CLEANUP_RESULT_WARNING =
  "[pi-subagents-minimal] Retention cleanup skipped one or more records.";

/** Path-only diagnostic for one skipped or failed record (S11). */
export interface CleanupWarning {
  /** Absolute path of the file or directory. No record contents. */
  path: string;
  /** Fixed category message. No parser text, values, or detail arrays. */
  message: string;
}

/**
 * Deterministic cleanup outcome: deleted paths in lexical order plus
 * warnings in lexical path order.
 */
export interface CleanupResult {
  /** Absolute paths unlinked by this cleanup, in lexical order. */
  deletedPaths: string[];
  /** Number of records deleted. Always `deletedPaths.length`. */
  deletedCount: number;
  /** Fixed path-only warnings, in lexical path order. */
  warnings: CleanupWarning[];
}

/** Explicit project scope plus the immutable effective retention days. */
export interface RetentionOptions {
  /** Pi agent directory; the state root is derived from it. */
  agentDir: string;
  /** Project path; only its canonical hash enters storage paths. */
  projectPath: string;
  /** Effective `historyRetentionDays` (default 7, bounds enforced by config). */
  historyRetentionDays: number;
  /** Cleanup clock in epoch milliseconds. */
  nowMs: number;
  /** Test-only hook after initial eligibility and before the final locked check. */
  beforeFinalDelete?: (path: string) => void | Promise<void>;
}

/**
 * Lifecycle context: explicit project scope with the immutable effective
 * config and clock. `nowMs` defaults to `Date.now()`; tests pass it.
 */
export interface ProjectRetentionContext {
  /** Pi agent directory; the state root is derived from it. */
  agentDir: string;
  /** Project path; only its canonical hash enters storage paths. */
  projectPath: string;
  /** Immutable effective config loaded once per activation. */
  config: MinimalSubagentsConfig;
  /** Cleanup clock in epoch milliseconds. Defaults to `Date.now()`. */
  nowMs?: number;
}

/** True for a missing-directory listing failure. Those are silent. */
function isMissingDir(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Direct lowercase `.json` children in lexical order. */
function recordNames(entries: string[]): string[] {
  return entries.filter((name) => name.endsWith(RECORD_FILE_EXTENSION)).sort();
}

/**
 * Decide eligibility for one validated record: active and not-yet-expired
 * records are kept silently, future completions warn, and expired terminal
 * records are returned for deletion. Pure and read-only.
 */
function inspectValidated(
  path: string,
  name: string,
  dataId: string,
  status: RunStatus,
  completedAt: string | undefined,
  historyRetentionDays: number,
  nowMs: number,
): { deletePath?: string; warning?: CleanupWarning } {
  const skip = (message: string): { warning: CleanupWarning } => ({
    warning: { path, message },
  });
  if (basename(name, RECORD_FILE_EXTENSION) !== dataId) {
    return skip(RETENTION_WARNINGS.invalid);
  }
  if (!isTerminalStatus(status)) return {};
  // Validators require a parseable `completed_at` for terminal records; the
  // type guard keeps this destructive path honest if that ever changes.
  if (typeof completedAt !== "string") return skip(RETENTION_WARNINGS.invalid);
  const elapsed = nowMs - Date.parse(completedAt);
  if (elapsed < 0) return skip(RETENTION_WARNINGS.futureTimestamp);
  if (elapsed < historyRetentionDays * DAY_IN_MS) return {};
  return { deletePath: path };
}

interface RecordIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface DeleteCandidate {
  path: string;
  identity: RecordIdentity;
}

function sameIdentity(left: RecordIdentity, right: RecordIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function recordIdentity(path: string): Promise<RecordIdentity> {
  const info = await lstat(path, { bigint: true });
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
  };
}

/** Inspect one raw record read-only for expiry eligibility and file identity. */
async function inspectRecord(
  root: string,
  path: string,
  name: string,
  historyRetentionDays: number,
  nowMs: number,
): Promise<{ deleteCandidate?: DeleteCandidate; warning?: CleanupWarning }> {
  const skip = (message: string): { warning: CleanupWarning } => ({
    warning: { path, message },
  });
  let text: string;
  let identityBefore: RecordIdentity;
  let identityAfter: RecordIdentity;
  try {
    identityBefore = await recordIdentity(path);
    text = await readStorageFile(root, path);
    identityAfter = await recordIdentity(path);
  } catch {
    return skip(RETENTION_WARNINGS.unreadable);
  }
  if (!sameIdentity(identityBefore, identityAfter)) {
    return skip(RETENTION_WARNINGS.unreadable);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return skip(RETENTION_WARNINGS.invalid);
  }
  let outcome: { deletePath?: string; warning?: CleanupWarning };
  {
    const envelope = parseSessionEnvelope(parsed);
    if (!envelope.ok) return skip(RETENTION_WARNINGS.invalid);
    outcome = inspectValidated(
      path,
      name,
      envelope.envelope.data.session_id,
      envelope.envelope.data.status,
      envelope.envelope.data.completed_at,
      historyRetentionDays,
      nowMs,
    );
  }
  if (outcome.deletePath === undefined) return outcome;
  return { deleteCandidate: { path, identity: identityAfter } };
}

/** Re-read, revalidate, and delete one candidate while holding its path lock. */
async function deleteExpired(
  root: string,
  candidate: DeleteCandidate,
  name: string,
  historyRetentionDays: number,
  nowMs: number,
  warnings: CleanupWarning[],
): Promise<string | undefined> {
  return withRecordStorageLock(candidate.path, async () => {
    const current = await inspectRecord(
      root,
      candidate.path,
      name,
      historyRetentionDays,
      nowMs,
    );
    if (current.warning !== undefined) {
      warnings.push(current.warning);
      return undefined;
    }
    if (current.deleteCandidate === undefined) return undefined;
    if (!sameIdentity(candidate.identity, current.deleteCandidate.identity)) {
      warnings.push({
        path: candidate.path,
        message: RETENTION_WARNINGS.deleteFailed,
      });
      return undefined;
    }
    try {
      assertContained(root, candidate.path, "retention record path");
      await unlinkStorageFile(root, candidate.path);
      return candidate.path;
    } catch {
      warnings.push({
        path: candidate.path,
        message: RETENTION_WARNINGS.deleteFailed,
      });
      return undefined;
    }
  });
}

/**
 * Project-wide retention cleanup (S13-S18).
 * Scans the record directory of every valid parent-session namespace under
 * the active project-key directory. Returns deterministic deleted paths and
 * warnings. A missing project namespace is silent.
 */
export async function cleanupProjectHistory(
  options: RetentionOptions,
): Promise<CleanupResult> {
  if (typeof options.nowMs !== "number" || !Number.isFinite(options.nowMs)) {
    throw new Error(
      "Invalid retention clock: expected finite epoch milliseconds.",
    );
  }
  if (
    typeof options.historyRetentionDays !== "number" ||
    !Number.isFinite(options.historyRetentionDays) ||
    options.historyRetentionDays <= 0
  ) {
    throw new Error(
      "Invalid history retention: expected a positive number of days.",
    );
  }
  const root = stateRootForAgentDir(options.agentDir);
  const projectDir = projectDirForProject({
    agentDir: options.agentDir,
    projectPath: options.projectPath,
  });
  const warnings: CleanupWarning[] = [];
  let entries: string[];
  try {
    await verifyStorageDirectory(root, projectDir, "project namespace");
    entries = await readdir(projectDir);
  } catch (err) {
    // A missing project namespace is silent; nothing has ever been stored.
    if (isMissingDir(err)) {
      return { deletedPaths: [], deletedCount: 0, warnings };
    }
    warnings.push({
      path: projectDir,
      message: RETENTION_WARNINGS.directoryUnreadable,
    });
    return { deletedPaths: [], deletedCount: 0, warnings };
  }

  // Collect every candidate file first so inspection stays read-only and the
  // outcome order is deterministic regardless of namespace layout.
  const candidates: Array<{ path: string; name: string }> = [];
  for (const namespace of [...entries].sort()) {
    try {
      assertValidParentSessionId(namespace);
    } catch {
      continue;
    }
    const namespaceDir = join(projectDir, namespace);
    try {
      await verifyStorageDirectory(
        root,
        namespaceDir,
        "parent-session namespace",
      );
    } catch (err) {
      if (!isMissingDir(err)) {
        warnings.push({
          path: namespaceDir,
          message: RETENTION_WARNINGS.directoryUnreadable,
        });
      }
      continue;
    }
    const dir = join(namespaceDir, SESSIONS_DIR_NAME);
    let names: string[] = [];
    try {
      await verifyStorageDirectory(root, dir, "records directory");
      names = recordNames(await readdir(dir));
    } catch (err) {
      if (!isMissingDir(err)) {
        warnings.push({
          path: dir,
          message: RETENTION_WARNINGS.directoryUnreadable,
        });
      }
    }
    for (const name of names) {
      candidates.push({ path: join(dir, name), name });
    }
  }
  candidates.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  const expired: Array<{
    candidate: DeleteCandidate;
    name: string;
  }> = [];
  for (const candidate of candidates) {
    const outcome = await inspectRecord(
      root,
      candidate.path,
      candidate.name,
      options.historyRetentionDays,
      options.nowMs,
    );
    if (outcome.warning !== undefined) warnings.push(outcome.warning);
    if (outcome.deleteCandidate !== undefined) {
      expired.push({
        candidate: outcome.deleteCandidate,
        name: candidate.name,
      });
    }
  }

  const deletedPaths: string[] = [];
  for (const expiredRecord of expired) {
    await options.beforeFinalDelete?.(expiredRecord.candidate.path);
    const deleted = await deleteExpired(
      root,
      expiredRecord.candidate,
      expiredRecord.name,
      options.historyRetentionDays,
      options.nowMs,
      warnings,
    );
    if (deleted !== undefined) deletedPaths.push(deleted);
  }
  deletedPaths.sort();
  warnings.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { deletedPaths, deletedCount: deletedPaths.length, warnings };
}

/** Resolve lifecycle context to explicit retention inputs. */
function toRetentionOptions(ctx: ProjectRetentionContext): RetentionOptions {
  return {
    agentDir: ctx.agentDir,
    projectPath: ctx.projectPath,
    historyRetentionDays: ctx.config.historyRetentionDays,
    nowMs: ctx.nowMs ?? Date.now(),
  };
}

/**
 * Activation cleanup (S15): run during extension activation with the
 * effective config and clock. The host awaits the extension factory, so this
 * is awaited — never fire-and-forget.
 */
export function cleanupOnActivation(
  ctx: ProjectRetentionContext,
): Promise<CleanupResult> {
  return cleanupProjectHistory(toRetentionOptions(ctx));
}

/** Post-terminal-settlement cleanup (S15): the 002 session manager
 * must call this only after it has successfully persisted the
 * terminal record. It then expires old histories project-wide with the
 * effective config and clock.
 */
export function cleanupAfterTerminalSettlement(
  ctx: ProjectRetentionContext,
): Promise<CleanupResult> {
  return cleanupProjectHistory(toRetentionOptions(ctx));
}
