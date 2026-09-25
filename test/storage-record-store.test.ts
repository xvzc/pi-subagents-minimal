/**
 * Record-store tests (003 T2, S7-S12, S19-S21, A1-A2, A4-A6).
 *
 * Covers atomic writes and owner-only permissions, exact envelopes in the
 * session namespace, interrupted-write survival with
 * temp cleanup, reload isolation with path-only redacted diagnostics in
 * lexical order, unchanged terminal rereads, restart normalization persisted
 * before exposure with an injected clock, normalization-failure behavior,
 * missing directories, write-validation failures, and data-only loads.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MinimalSubagentsError } from "../src/errors.js";
import {
  namespaceRootForParentSession,
  projectDirForProject,
  sessionRecordPath,
  sessionRecordsDirForParentSession,
  stateRootForAgentDir,
} from "../src/storage/paths.js";
import {
  RecordStore,
  SESSION_RECORD_WARNINGS,
  SESSION_RESTART_INTERRUPTION_ERROR,
} from "../src/storage/record-store.js";
import type { PersistedSessionSnapshot } from "../src/storage/schemas.js";

const CREATED = "2026-09-21T00:00:00.000Z";
const RESTARTED = "2026-09-21T02:00:00.000Z";
const SECRET = "SECRET-OUTPUT-9f2c41";

const POSIX = process.platform !== "win32";
const NON_ROOT = typeof process.getuid !== "function" || process.getuid() !== 0;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

function freshNamespace() {
  const root = mkdtempSync(join(tmpdir(), "pi-record-store-"));
  tempRoots.push(root);
  return {
    agentDir: join(root, "agent"),
    projectPath: join(root, "work", "proj"),
    parentSessionId: "parent1",
  };
}

function activeSession(
  sessionId = "00000000-0000-0007",
): PersistedSessionSnapshot {
  return {
    session_id: sessionId,
    agent: "coder",
    model: "pi-model",
    thinking: "low",
    status: "running",
    created_at: CREATED,
    started_at: CREATED,
  };
}

function terminalSession(
  sessionId = "00000000-0000-005a",
  output = "done output",
): PersistedSessionSnapshot {
  return {
    session_id: sessionId,
    agent: "coder",
    model: "pi-model",
    thinking: "medium",
    status: "completed",
    created_at: CREATED,
    started_at: CREATED,
    completed_at: "2026-09-21T01:00:00.000Z",
    output,
  };
}

/** Seed a raw file, creating its directory. Strings are written verbatim. */
function seedRaw(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function seedEnvelope(dir: string, name: string, envelope: unknown): string {
  return seedRaw(dir, name, JSON.stringify(envelope));
}

/** Assert a loaded snapshot is plain data with no live-handle keys. */
function assertDataOnly(value: unknown): void {
  const live = new Set([
    "worker",
    "session",
    "controller",
    "callback",
    "abortcontroller",
    "promise",
    "handle",
    "conversation",
    "timer",
    "socket",
    "stream",
    "filehandle",
    "vmcontext",
    "__proto__",
  ]);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, entry] of Object.entries(node)) {
        expect(live.has(key.toLowerCase())).toBe(false);
        expect(typeof entry === "function").toBe(false);
        visit(entry);
      }
    }
  };
  visit(value);
  expect(JSON.parse(JSON.stringify(value) as string)).toEqual(value);
}

describe("writes and reload", () => {
  it("round-trips session snapshots with exact envelopes", async () => {
    const ns = freshNamespace();
    const store = new RecordStore(ns);
    const session = terminalSession();
    await store.writeSession(session);

    const sessionPath = sessionRecordPath({
      ...ns,
      sessionId: session.session_id,
    });
    expect(sessionPath).toContain(`${"sessions"}`);
    expect(JSON.parse(readFileSync(sessionPath, "utf8"))).toEqual({
      version: 1,
      kind: "session",
      data: session,
    });

    const sessions = await store.loadSessions();
    expect(sessions).toEqual({ records: [session], warnings: [] });

    const sessionFiles = readdirSync(sessionRecordsDirForParentSession(ns));
    expect(sessionFiles).toEqual([`${session.session_id}.json`]);
  });

  it("atomically replaces a prior record with repeated unique-temp writes", async () => {
    const ns = freshNamespace();
    const store = new RecordStore(ns);
    await store.writeSession(
      terminalSession("00000000-0000-004b", "version one"),
    );
    for (let index = 0; index < 20; index++) {
      await store.writeSession(
        terminalSession("00000000-0000-004b", `version ${index}`),
      );
    }
    await store.writeSession(
      terminalSession("00000000-0000-004b", "version final"),
    );
    const loaded = await store.loadSessions();
    expect(loaded.warnings).toEqual([]);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]?.output).toBe("version final");
    const dir = sessionRecordsDirForParentSession(ns);
    expect(readdirSync(dir)).toEqual(["00000000-0000-004b.json"]);
  });
});

describe("interrupted writes", () => {
  it("leaves the prior record intact and cleans only its own temp file", async () => {
    const ns = freshNamespace();
    const store = new RecordStore(ns);
    const previous = terminalSession(
      "00000000-0000-0063",
      "previous complete record",
    );
    await store.writeSession(previous);
    const dest = sessionRecordPath({ ...ns, sessionId: previous.session_id });
    const before = readFileSync(dest, "utf8");

    const failing = new RecordStore({
      ...ns,
      beforeRename: () => {
        throw new Error("injected pre-rename failure");
      },
    });
    const next = terminalSession("00000000-0000-0063", SECRET);
    const failure = await failing.writeSession(next).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(MinimalSubagentsError);
    expect((failure as MinimalSubagentsError).code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(failure)).not.toContain(SECRET);

    // Prior destination is untouched and still parses; no temp files remain.
    expect(readFileSync(dest, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(dest, "utf8")).data).toEqual(previous);
    const entries = readdirSync(sessionRecordsDirForParentSession(ns));
    expect(entries).toEqual(["00000000-0000-0063.json"]);
    expect(entries.some((entry) => entry.includes(".tmp"))).toBe(false);

    // The failed operation released its per-record lock; a later replacement
    // of the same path can complete normally.
    const recovered = terminalSession("00000000-0000-0063", "recovered record");
    await store.writeSession(recovered);
    expect(JSON.parse(readFileSync(dest, "utf8")).data).toEqual(recovered);
  });

  it("rejects invalid snapshots without embedding contents or creating files", async () => {
    const ns = freshNamespace();
    const store = new RecordStore(ns);
    const invalid = {
      ...terminalSession("00000000-0000-000f", SECRET),
      completed_at: undefined,
      metadata: { worker: { pid: 1 } },
    } as unknown as PersistedSessionSnapshot;
    const failure = await store.writeSession(invalid).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(MinimalSubagentsError);
    expect((failure as MinimalSubagentsError).code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(existsSync(sessionRecordsDirForParentSession(ns))).toBe(false);
  });
});

describe("permissions", () => {
  it.runIf(POSIX)(
    "uses owner-only dirs and files, including after replacement",
    async () => {
      const ns = freshNamespace();
      const store = new RecordStore(ns);
      await store.writeSession(terminalSession());
      await store.writeSession(
        terminalSession("00000000-0000-005a", "replaced"),
      );

      const root = stateRootForAgentDir(ns.agentDir);
      const projectDir = projectDirForProject(ns);
      const parentDir = namespaceRootForParentSession(ns);
      const sessionsDir = sessionRecordsDirForParentSession(ns);
      for (const dir of [root, projectDir, parentDir, sessionsDir]) {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      const sessionPath = sessionRecordPath({
        ...ns,
        sessionId: "00000000-0000-005a",
      });
      expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
    },
  );
});

describe("physical containment", () => {
  it.runIf(POSIX)(
    "refuses writes through a linked project ancestor",
    async () => {
      const ns = freshNamespace();
      const root = stateRootForAgentDir(ns.agentDir);
      const projectDir = projectDirForProject(ns);
      const outside = join(tempRoots[0] as string, "outside-write");
      mkdirSync(root, { recursive: true });
      mkdirSync(outside);
      const sentinel = join(outside, "sentinel.bin");
      writeFileSync(sentinel, "outside-bytes", "utf8");
      symlinkSync(outside, projectDir, "dir");

      await expect(
        new RecordStore(ns).writeSession(terminalSession("00000000-0000-0019")),
      ).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
      expect(readFileSync(sentinel, "utf8")).toBe("outside-bytes");
      expect(existsSync(join(outside, ns.parentSessionId))).toBe(false);
    },
  );

  it.runIf(POSIX)(
    "does not load through linked record directories or files",
    async () => {
      const ns = freshNamespace();
      const dir = sessionRecordsDirForParentSession(ns);
      const outside = join(tempRoots[0] as string, "outside-load");
      mkdirSync(outside);
      const record = terminalSession("00000000-0000-002a");
      const outsideRecord = join(outside, "00000000-0000-002a.json");
      const bytes = JSON.stringify({
        version: 1,
        kind: "session",
        data: record,
      });
      writeFileSync(outsideRecord, bytes, "utf8");

      mkdirSync(namespaceRootForParentSession(ns), { recursive: true });
      symlinkSync(outside, dir, "dir");
      const linkedDirResult = await new RecordStore(ns).loadSessions();
      expect(linkedDirResult).toEqual({
        records: [],
        warnings: [
          { path: dir, message: SESSION_RECORD_WARNINGS.directoryUnreadable },
        ],
      });
      expect(readFileSync(outsideRecord, "utf8")).toBe(bytes);

      rmSync(dir);
      mkdirSync(dir);
      const linkedFile = join(dir, "00000000-0000-002a.json");
      symlinkSync(outsideRecord, linkedFile, "file");
      const linkedFileResult = await new RecordStore(ns).loadSessions();
      expect(linkedFileResult).toEqual({
        records: [],
        warnings: [
          { path: linkedFile, message: SESSION_RECORD_WARNINGS.unreadable },
        ],
      });
      expect(readFileSync(outsideRecord, "utf8")).toBe(bytes);
    },
  );
});

describe("loading isolation and diagnostics", () => {
  it("skips each invalid session file independently with fixed redacted warnings in lexical order", async () => {
    const ns = freshNamespace();
    const dir = sessionRecordsDirForParentSession(ns);
    const valid = terminalSession("00000000-0000-0006", "kept output");
    // Create in non-lexical order to prove sorted diagnostics.
    seedEnvelope(dir, "00000000-0000-0067.json", {
      version: 1,
      kind: "session",
      data: {
        ...valid,
        session_id: "00000000-0000-0067",
        status: "bogus",
        output: SECRET,
      },
    });
    seedEnvelope(dir, "00000000-0000-0006.json", {
      version: 1,
      kind: "session",
      data: valid,
    });
    seedRaw(dir, "00000000-0000-000e.json", `{corrupt json ${SECRET}`);
    seedEnvelope(dir, "00000000-0000-0011.json", {
      version: 99,
      kind: "session",
      data: { ...valid, session_id: "00000000-0000-0011", output: SECRET },
    });
    seedEnvelope(dir, "00000000-0000-0014.json", {
      version: 1,
      kind: "workflow",
      data: { ...valid, session_id: "00000000-0000-0014", output: SECRET },
    });
    seedEnvelope(dir, "00000000-0000-0018.json", {
      version: 1,
      kind: "session",
      data: { ...valid, session_id: "00000000-0000-0048", output: SECRET },
    });
    mkdirSync(join(dir, "00000000-0000-001c.json"));
    // Ignored silently: non-.json, uppercase suffix, and stale temp names.
    seedRaw(dir, "notes.txt", `garbage ${SECRET}`);
    seedRaw(dir, "00000000-0000-0021.JSON", "garbage");
    seedRaw(dir, ".00000000-0000-0006.json.1.tmp", "stale temp");

    const store = new RecordStore(ns);
    const result = await store.loadSessions();
    expect(result.records).toEqual([valid]);
    expect(result.warnings.map((warning) => warning.path)).toEqual(
      [
        "00000000-0000-000e.json",
        "00000000-0000-0011.json",
        "00000000-0000-0014.json",
        "00000000-0000-0018.json",
        "00000000-0000-001c.json",
        "00000000-0000-0067.json",
      ].map((name) => join(dir, name)),
    );
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      SESSION_RECORD_WARNINGS.corrupt,
      SESSION_RECORD_WARNINGS.unsupportedVersion,
      SESSION_RECORD_WARNINGS.kindMismatch,
      SESSION_RECORD_WARNINGS.idMismatch,
      SESSION_RECORD_WARNINGS.unreadable,
      SESSION_RECORD_WARNINGS.invalidSchema,
    ]);
    // Fixed diagnostics only: no parser text, payloads, or detail arrays.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("Unexpected");
    expect(serialized).not.toContain("bogus");
    for (const warning of result.warnings) {
      expect(Object.values(SESSION_RECORD_WARNINGS)).toContain(warning.message);
    }
  });

  it("skips legacy session records without migration", async () => {
    const ns = freshNamespace();
    const dir = sessionRecordsDirForParentSession(ns);
    const legacyPath = seedEnvelope(dir, "ses_legacy.json", {
      version: 1,
      kind: "session",
      data: {
        ...terminalSession("00000000-0000-0001"),
        session_id: "ses_legacy",
      },
    });

    expect(await new RecordStore(ns).loadSessions()).toEqual({
      records: [],
      warnings: [
        {
          path: legacyPath,
          message: SESSION_RECORD_WARNINGS.invalidSchema,
        },
      ],
    });
  });

  it("loads sessions while ignoring a foreign records directory", async () => {
    const ns = freshNamespace();
    const store = new RecordStore(ns);
    await store.writeSession(terminalSession("00000000-0000-003d"));
    seedRaw(
      sessionRecordsDirForParentSession(ns),
      "00000000-0000-000f.json",
      "{broken",
    );
    // Files outside the sessions directory are never read.
    seedRaw(
      join(namespaceRootForParentSession(ns), "workflows"),
      "wf_bad.json",
      "{broken",
    );

    const sessions = await new RecordStore(ns).loadSessions();
    expect(sessions.records.map((record) => record.session_id)).toEqual([
      "00000000-0000-003d",
    ]);
    expect(sessions.warnings).toHaveLength(1);
  });

  it("returns empty loads for missing directories", async () => {
    const store = new RecordStore(freshNamespace());
    expect(await store.loadSessions()).toEqual({ records: [], warnings: [] });
  });

  it.runIf(POSIX && NON_ROOT)(
    "warns on unreadable files without blocking siblings",
    async () => {
      const ns = freshNamespace();
      const dir = sessionRecordsDirForParentSession(ns);
      const valid = terminalSession("00000000-0000-003a");
      seedEnvelope(dir, "00000000-0000-003a.json", {
        version: 1,
        kind: "session",
        data: valid,
      });
      const blocked = seedEnvelope(dir, "00000000-0000-0034.json", {
        version: 1,
        kind: "session",
        data: { ...valid, session_id: "00000000-0000-0034" },
      });
      chmodSync(blocked, 0o000);
      try {
        const result = await new RecordStore(ns).loadSessions();
        expect(result.records).toEqual([valid]);
        expect(result.warnings).toEqual([
          { path: blocked, message: SESSION_RECORD_WARNINGS.unreadable },
        ]);
      } finally {
        chmodSync(blocked, 0o600);
      }
    },
  );
});

describe("terminal rereads", () => {
  it("does not mutate or delete already-terminal records", async () => {
    const ns = freshNamespace();
    const store = new RecordStore(ns);
    const session = terminalSession();
    await store.writeSession(session);
    const sessionPath = sessionRecordPath({
      ...ns,
      sessionId: session.session_id,
    });

    await store.loadSessions();
    const sessionBefore = readFileSync(sessionPath, "utf8");
    const sessionMtime = statSync(sessionPath).mtimeMs;

    const sessions = await store.loadSessions();
    expect(sessions.records).toEqual([session]);
    expect(readFileSync(sessionPath, "utf8")).toBe(sessionBefore);
    expect(statSync(sessionPath).mtimeMs).toBe(sessionMtime);
  });
});

describe("restart normalization", () => {
  it("normalizes active sessions to aborted with the injected clock, persisted before return", async () => {
    const ns = freshNamespace();
    const running = activeSession("00000000-0000-0024");
    const queued: PersistedSessionSnapshot = {
      ...activeSession("00000000-0000-0061"),
      status: "queued",
    };
    const writer = new RecordStore(ns);
    await writer.writeSession(running);
    await writer.writeSession(queued);

    // Simulate a restart with a fresh store and deterministic clock.
    const reader = new RecordStore({ ...ns, now: () => RESTARTED });
    const result = await reader.loadSessions();
    expect(result.warnings).toEqual([]);
    expect(result.records).toEqual([
      {
        ...running,
        status: "aborted",
        completed_at: RESTARTED,
        error: SESSION_RESTART_INTERRUPTION_ERROR,
      },
      {
        ...queued,
        status: "aborted",
        completed_at: RESTARTED,
        error: SESSION_RESTART_INTERRUPTION_ERROR,
      },
    ]);

    // Persisted before exposure: disk already holds the aborted records.
    for (const record of result.records) {
      const path = sessionRecordPath({ ...ns, sessionId: record.session_id });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        version: 1,
        kind: "session",
        data: record,
      });
      assertDataOnly(record);
    }

    // A second load finds terminal records and rewrites nothing.
    const dest = sessionRecordPath({ ...ns, sessionId: running.session_id });
    const mtime = statSync(dest).mtimeMs;
    const again = await reader.loadSessions();
    expect(again.warnings).toEqual([]);
    expect(again.records).toHaveLength(2);
    expect(statSync(dest).mtimeMs).toBe(mtime);
  });

  it("skips active records when normalization cannot persist, preserving the prior file", async () => {
    const ns = freshNamespace();
    const running = activeSession("00000000-0000-0058");
    await new RecordStore(ns).writeSession(running);
    const dest = sessionRecordPath({ ...ns, sessionId: running.session_id });
    const before = readFileSync(dest, "utf8");

    const failing = new RecordStore({
      ...ns,
      now: () => RESTARTED,
      beforeRename: () => {
        throw new Error("injected normalization failure");
      },
    });
    const result = await failing.loadSessions();
    expect(result.records).toEqual([]);
    expect(result.warnings).toEqual([
      { path: dest, message: SESSION_RECORD_WARNINGS.normalizationFailed },
    ]);
    // No fabricated normalized state is exposed and the prior file survives.
    expect(readFileSync(dest, "utf8")).toBe(before);
    expect(JSON.parse(before).data.status).toBe("running");
    expect(JSON.stringify(result)).not.toContain("aborted");
  });
});
