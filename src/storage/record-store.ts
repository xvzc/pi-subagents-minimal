/**
 * Atomic record store (003 T2, S7-S12, S19-S21).
 *
 * Layout (from T1 path helpers):
 * `<agent-dir>/subagents-state/<project-key>/<parent-session-id>/{sessions}/<run-id>.json`
 *
 * Writes (S7-S8): snapshots are validated before touching disk, then persisted
 * via a uniquely named temporary file created beside the destination with
 * exclusive creation with no-follow semantics where supported and mode `0600`.
 * Content is fully written, synced, closed, and atomically renamed over the
 * destination. Replacements are serialized by absolute destination path with
 * retention's final check/deletion in this process. A failure before rename
 * leaves any prior destination intact; only this operation's temp file is removed best-effort.
 * Nothing unrelated is ever deleted for recovery (N1). Every storage directory
 * from the state root through the record directory is enforced as `0700` where
 * supported (N3).
 *
 * Loads (S9-S12): the session namespace loads on its own. Only
 * direct children ending in lowercase `.json` are read, in lexical order.
 * Missing directories are silent. Corrupt, unknown-version, kind-mismatched,
 * schema-invalid, filename/data-ID mismatched, and unreadable files are skipped
 * independently with fixed path-only/category diagnostics: warnings carry
 * `{ path, message }` where `message` is a constant. They never include JSON
 * parser text, stored outputs/results/prompts/errors, field values, or T1
 * validation detail arrays (S11). Repeated reads never mutate or delete files
 * (S12): only interrupted active records are rewritten (see below).
 *
 * Restart normalization (S21): persisted `queued`/`running` session records found on
 * load have no live worker or conversation behind them, so they are normalized
 * to `aborted` with a deterministic restart-interruption stored error and a
 * `completed_at` from the injected clock, atomically persisted before exposure,
 * and returned aborted. If normalization cannot be persisted, the record is
 * skipped with a warning and no fabricated normalized state is exposed; the
 * prior file is preserved whenever the failure happened before rename.
 *
 * Data-only boundary (S19-S20, C4): loaded snapshots are plain serializable
 * data. This store never creates or claims a live conversation handle. Reloaded
 * terminal sessions are inspectable via this load result, but resume/steer
 * decisions belong to the session runtime (002), which must surface resume as
 * `SESSION_NOT_RESUMABLE` and steer as `SESSION_NOT_RUNNING`; that behavior is
 * out of scope here, so A5 remains partial to inspection plus this explicit boundary.
 *
 * Out of scope: retention cleanup (T3) and the session manager. This
 * module takes explicit `agentDir`/`projectPath`/`parentSessionId` plus two
 * optional test-only seams: `now` (deterministic restart timestamps) and
 * `beforeRename` (deterministic pre-rename failure injection). It reads no host
 * state and no credentials.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MinimalSubagentsError } from "../errors.js";
import {
  ensureStorageDirectory,
  type NamespaceOptions,
  readStorageFile,
  sessionRecordPath,
  sessionRecordsDirForParentSession,
  stateRootForAgentDir,
  unlinkStorageFile,
  verifyStorageDirectory,
  verifyStorageFile,
} from "./paths.js";
import {
  type PersistedSessionSnapshot,
  parseSessionEnvelope,
  STORED_RECORD_VERSION,
  type StoredError,
  validateSessionSnapshot,
} from "./schemas.js";
import { withRecordStorageLock } from "./storage-coordinator.js";

/** Directory mode for state directories where supported (S8, N3). */
export const RECORD_DIR_MODE = 0o700;

/** File mode for record and temp files where supported (S8, N3). */
export const RECORD_FILE_MODE = 0o600;

/** Lowercase record file suffix. Anything else is ignored silently. */
const RECORD_SUFFIX = ".json";

/** Fixed path-only diagnostics for session records (S11). */
export const SESSION_RECORD_WARNINGS = {
  unreadable: "Skipped unreadable session record.",
  corrupt: "Skipped corrupt session record.",
  unsupportedVersion: "Skipped session record with unsupported version.",
  kindMismatch: "Skipped session record with kind mismatch.",
  invalidSchema: "Skipped invalid session record.",
  idMismatch: "Skipped session record with filename/data ID mismatch.",
  normalizationFailed:
    "Skipped session record that could not be normalized after restart.",
  directoryUnreadable: "Skipped unreadable session records directory.",
} as const;

/** Deterministic restart-interruption error stored on normalized sessions. */
export const SESSION_RESTART_INTERRUPTION_ERROR: StoredError = Object.freeze({
  code: "RESTART_INTERRUPTED",
  message:
    "The session was active when the process restarted; it was marked aborted.",
});

/** Path-only diagnostic for one skipped record (S10-S11). */
export interface LoadWarning {
  /** Absolute path of the skipped file. No record contents. */
  path: string;
  /** Fixed category message. No parser text, values, or detail arrays. */
  message: string;
}

/**
 * Load-result boundary (S19-S20): valid data-only snapshots plus warnings.
 * Snapshots carry no live handle; the session runtime (002) must treat
 * reloaded resume as `SESSION_NOT_RESUMABLE` and steer as `SESSION_NOT_RUNNING`.
 */
export interface LoadResult<T> {
  records: T[];
  warnings: LoadWarning[];
}

/**
 * Test-only pre-rename hook. Runs after the temp file is fully written,
 * synced, closed, and permissioned, but before the atomic rename. Throwing
 * simulates an interrupted write: the prior destination stays intact and only
 * this operation's temp file is removed. Production callers never set it.
 */
export type BeforeRenameHook = (
  tmpPath: string,
  destPath: string,
) => void | Promise<void>;

/** Explicit namespace plus optional test-only seams. No host state. */
export interface RecordStoreOptions extends NamespaceOptions {
  /** Restart-timestamp source. Defaults to the current time as ISO-8601. */
  now?: () => string;
  /** Failure-injection hook before rename. Tests only. */
  beforeRename?: BeforeRenameHook;
}

/** Sequence distinguishing temp files within one process. */
let tempSequence = 0;

/**
 * Create a uniquely named temp file beside the destination with exclusive
 * creation and owner-only mode. Retries on the rare exclusive-create collision.
 */
async function createExclusiveTemp(
  root: string,
  dir: string,
  base: string,
): Promise<{ tmpPath: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    tempSequence += 1;
    const unique = `${process.pid}.${Date.now()}.${tempSequence}.${randomBytes(8).toString("hex")}`;
    const tmpPath = join(dir, `.${base}.${unique}.tmp`);
    try {
      await verifyStorageDirectory(root, dir, "record directory");
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const handle = await open(
        tmpPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        RECORD_FILE_MODE,
      );
      return { tmpPath, handle };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST")
        continue;
      throw err;
    }
  }
  throw new Error(`Could not create a unique temporary file in ${dir}.`);
}

/**
 * Atomically replace `destPath` with `text` (S7-S8).
 * Best-effort removes only this operation's temp file on failure and never
 * touches any other file. Throws the raw failure; callers map it to a safe
 * persistence error.
 */
async function writeTextAtomic(
  root: string,
  destPath: string,
  text: string,
  beforeRename?: BeforeRenameHook,
): Promise<void> {
  await withRecordStorageLock(destPath, async () => {
    const dir = dirname(destPath);
    await ensureStorageDirectory(root, dir, "record directory");
    await verifyStorageDirectory(root, dir, "record directory");
    const { tmpPath, handle } = await createExclusiveTemp(
      root,
      dir,
      basename(destPath),
    );
    let committed = false;
    try {
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await verifyStorageFile(root, tmpPath, "temporary record file");
      await beforeRename?.(tmpPath, destPath);
      await verifyStorageDirectory(root, dir, "record directory");
      await verifyStorageFile(root, tmpPath, "temporary record file");
      try {
        await verifyStorageFile(root, destPath, "record file");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await rename(tmpPath, destPath);
      committed = true;
      await verifyStorageFile(root, destPath, "record file");
    } finally {
      if (!committed) {
        try {
          await unlinkStorageFile(root, tmpPath);
        } catch {
          /* best-effort: temp cleanup must not mask the original failure */
        }
      }
    }
  });
}

/** Direct lowercase `.json` children in lexical order. Missing dirs are silent. */
async function listRecordNames(root: string, dir: string): Promise<string[]> {
  let entries: string[];
  try {
    await verifyStorageDirectory(root, dir, "records directory");
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new MinimalSubagentsError(
      "INTERNAL_ERROR",
      `Failed to list stored records in ${dir}.`,
    );
  }
  return entries.filter((name) => name.endsWith(RECORD_SUFFIX)).sort();
}

/** True for records with no live worker behind them after a restart. */
function isActiveStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

/**
 * Atomic record store for one parent-session namespace.
 * Construct from explicit namespace values; the two optional seams exist only
 * for deterministic tests. Reads no host state and no credentials.
 */
export class RecordStore {
  private readonly namespace: NamespaceOptions;
  private readonly clock: () => string;
  private readonly beforeRename: BeforeRenameHook | undefined;

  constructor(options: RecordStoreOptions) {
    const { now, beforeRename, ...namespace } = options;
    // Fail fast on an invalid namespace before any I/O.
    sessionRecordsDirForParentSession(namespace);
    if (now !== undefined && typeof now !== "function") {
      throw new Error("Invalid record store clock: expected a function.");
    }
    if (beforeRename !== undefined && typeof beforeRename !== "function") {
      throw new Error("Invalid record store hook: expected a function.");
    }
    this.namespace = { ...namespace };
    this.clock = now ?? (() => new Date().toISOString());
    this.beforeRename = beforeRename;
  }

  private get root(): string {
    return stateRootForAgentDir(this.namespace.agentDir);
  }

  /**
   * Validate and atomically persist a session snapshot (R1, S7-S8).
   * The destination ID/path comes from the accepted path helpers; envelope
   * kind and data ID agree by construction. Failures throw a safe
   * `INTERNAL_ERROR` without snapshot contents.
   */
  async writeSession(snapshot: PersistedSessionSnapshot): Promise<void> {
    const validated = validateSessionSnapshot(snapshot);
    if (!validated.ok) {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "Invalid session snapshot: record not persisted.",
      );
    }
    let dest: string;
    try {
      dest = sessionRecordPath({
        ...this.namespace,
        sessionId: validated.snapshot.session_id,
      });
    } catch {
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        "Invalid session snapshot: record not persisted.",
      );
    }
    const envelope = {
      version: STORED_RECORD_VERSION,
      kind: "session",
      data: validated.snapshot,
    } as const;
    try {
      await writeTextAtomic(
        this.root,
        dest,
        JSON.stringify(envelope),
        this.beforeRename,
      );
    } catch (err) {
      if (err instanceof MinimalSubagentsError) throw err;
      throw new MinimalSubagentsError(
        "INTERNAL_ERROR",
        `Failed to persist session record at ${dest}.`,
      );
    }
  }

  /**
   * Load valid session snapshots (S9-S10).
   * Invalid files are skipped with path-only warnings; other records still
   * load. Never mutates terminal records (S12).
   */
  async loadSessions(): Promise<LoadResult<PersistedSessionSnapshot>> {
    const dir = sessionRecordsDirForParentSession(this.namespace);
    const records: PersistedSessionSnapshot[] = [];
    const warnings: LoadWarning[] = [];
    let names: string[];
    try {
      names = await listRecordNames(this.root, dir);
    } catch {
      return {
        records,
        warnings: [
          { path: dir, message: SESSION_RECORD_WARNINGS.directoryUnreadable },
        ],
      };
    }
    for (const name of names) {
      const path = join(dir, name);
      const outcome = await this.readSessionFile(path, name);
      if (outcome.record !== undefined) records.push(outcome.record);
      if (outcome.warning !== undefined) warnings.push(outcome.warning);
    }
    return { records, warnings };
  }

  /** Read, validate, and maybe restart-normalize one session file. */
  private async readSessionFile(
    path: string,
    name: string,
  ): Promise<{ record?: PersistedSessionSnapshot; warning?: LoadWarning }> {
    const skip = (message: string): { warning: LoadWarning } => ({
      warning: { path, message },
    });
    let text: string;
    try {
      text = await readStorageFile(this.root, path);
    } catch {
      return skip(SESSION_RECORD_WARNINGS.unreadable);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return skip(SESSION_RECORD_WARNINGS.corrupt);
    }
    const envelope = parseSessionEnvelope(parsed);
    if (!envelope.ok) {
      if (envelope.reason === "unknown-version") {
        return skip(SESSION_RECORD_WARNINGS.unsupportedVersion);
      }
      if (envelope.reason === "kind-mismatch") {
        return skip(SESSION_RECORD_WARNINGS.kindMismatch);
      }
      return skip(SESSION_RECORD_WARNINGS.invalidSchema);
    }
    const data = envelope.envelope.data;
    if (basename(name, RECORD_SUFFIX) !== data.session_id) {
      return skip(SESSION_RECORD_WARNINGS.idMismatch);
    }
    if (isActiveStatus(data.status)) {
      const normalized = await this.normalizeSession(path, data);
      if (normalized === undefined) {
        return skip(SESSION_RECORD_WARNINGS.normalizationFailed);
      }
      return { record: normalized };
    }
    return { record: data };
  }

  /**
   * Normalize an interrupted active session to `aborted` and atomically
   * persist it before exposure (S21). Returns `undefined` when normalization
   * cannot be persisted; the prior file is preserved whenever the failure
   * happened before rename, and no fabricated state is exposed.
   */
  private async normalizeSession(
    path: string,
    data: PersistedSessionSnapshot,
  ): Promise<PersistedSessionSnapshot | undefined> {
    let completedAt: string;
    try {
      completedAt = this.clock();
    } catch {
      return undefined;
    }
    const normalized: PersistedSessionSnapshot = {
      ...data,
      status: "aborted",
      completed_at: completedAt,
      error: { ...SESSION_RESTART_INTERRUPTION_ERROR },
    };
    if (!validateSessionSnapshot(normalized).ok) return undefined;
    const envelope = {
      version: STORED_RECORD_VERSION,
      kind: "session",
      data: normalized,
    } as const;
    try {
      await writeTextAtomic(
        this.root,
        path,
        JSON.stringify(envelope),
        this.beforeRename,
      );
    } catch {
      return undefined;
    }
    return normalized;
  }
}
