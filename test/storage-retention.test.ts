/**
 * Retention-cleanup tests (003 T3, S13-S18, A3).
 *
 * Covers exact elapsed-day expiry with the default and custom retention
 * periods, before/exactly/after-boundary behavior, active-record exemption
 * without normalization, future-timestamp preservation, sessions across
 * multiple parent namespaces, missing-namespace silence,
 * invalid/corrupt/unknown/mismatched/unreadable preservation with fixed
 * redacted warnings in lexical order, lowercase-direct-JSON scoping with
 * temp/unrelated preservation, delete-failure warnings, containment, and the
 * activation plus post-settlement hooks delegating to the same cleanup.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import extension from "../src/index.js";
import {
  assertContained,
  projectDirForProject,
  sessionRecordPath,
  sessionRecordsDirForParentSession,
  stateRootForAgentDir,
} from "../src/storage/paths.js";
import { RecordStore } from "../src/storage/record-store.js";
import {
  cleanupAfterTerminalSettlement,
  cleanupOnActivation,
  cleanupProjectHistory,
  DAY_IN_MS,
  RETENTION_WARNINGS,
} from "../src/storage/retention.js";
import type { PersistedSessionSnapshot } from "../src/storage/schemas.js";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const SECRET = "SECRET-OUTPUT-7d4b92";
const POSIX = process.platform !== "win32";
const NON_ROOT = typeof process.getuid !== "function" || process.getuid() !== 0;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

function freshProject() {
  const root = mkdtempSync(join(tmpdir(), "pi-retention-"));
  tempRoots.push(root);
  return {
    agentDir: join(root, "agent"),
    projectPath: join(root, "work", "proj"),
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function terminalSession(
  sessionId: string,
  completedAt: string,
  status: PersistedSessionSnapshot["status"] = "completed",
  output = "done output",
): PersistedSessionSnapshot {
  return {
    session_id: sessionId,
    agent: "coder",
    model: "pi-model",
    thinking: "low",
    status,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: completedAt,
    output,
  };
}

function activeSession(
  sessionId: string,
  status: "queued" | "running" = "running",
): PersistedSessionSnapshot {
  return {
    session_id: sessionId,
    agent: "coder",
    model: "pi-model",
    thinking: "low",
    status,
    created_at: "2020-01-01T00:00:00.000Z",
    started_at: "2020-01-01T00:00:00.000Z",
  };
}

/** Seed a raw session envelope file, creating its directory. */
function seedSession(
  project: { agentDir: string; projectPath: string },
  parent: string,
  name: string,
  envelope: unknown,
): string {
  const dir = sessionRecordsDirForParentSession({
    ...project,
    parentSessionId: parent,
  });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(envelope), "utf8");
  return path;
}

function sessionEnvelope(data: PersistedSessionSnapshot): unknown {
  return { version: 1, kind: "session", data };
}

function cleanup(
  project: { agentDir: string; projectPath: string },
  nowMs: number = NOW,
  historyRetentionDays = 7,
) {
  return cleanupProjectHistory({ ...project, nowMs, historyRetentionDays });
}

describe("expiry boundaries", () => {
  it("deletes terminal records at or past 7 days with the default period, keeping newer ones", async () => {
    const project = freshProject();
    const old = seedSession(
      project,
      "parent1",
      "00000000-0000-003b.json",
      sessionEnvelope(
        terminalSession("00000000-0000-003b", iso(NOW - 8 * DAY_IN_MS)),
      ),
    );
    const exact = seedSession(
      project,
      "parent1",
      "00000000-0000-001a.json",
      sessionEnvelope(
        terminalSession("00000000-0000-001a", iso(NOW - 7 * DAY_IN_MS)),
      ),
    );
    const newer = seedSession(
      project,
      "parent1",
      "00000000-0000-0032.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0032", iso(NOW - 7 * DAY_IN_MS + 1000)),
      ),
    );
    const newerBytes = readFileSync(newer, "utf8");

    const result = await cleanup(project);

    expect(result.deletedPaths).toEqual([exact, old].sort());
    expect(result.deletedCount).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(exact)).toBe(false);
    expect(readFileSync(newer, "utf8")).toBe(newerBytes);
  });

  it("honors a custom retention period", async () => {
    const project = freshProject();
    const expired = seedSession(
      project,
      "parent1",
      "00000000-0000-0018.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0018", iso(NOW - 25 * 60 * 60 * 1000)),
      ),
    );
    const kept = seedSession(
      project,
      "parent1",
      "00000000-0000-0027.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0027", iso(NOW - 23 * 60 * 60 * 1000)),
      ),
    );

    const result = await cleanup(project, NOW, 1);

    expect(result.deletedPaths).toEqual([expired]);
    expect(result.deletedCount).toBe(1);
    expect(existsSync(kept)).toBe(true);
  });

  it("deletes every terminal status once expired", async () => {
    const project = freshProject();
    const statuses = ["completed", "failed", "stopped", "aborted"] as const;
    const paths = statuses.map((status, index) => {
      const sessionId = `00000000-0000-01${index.toString().padStart(2, "0")}`;
      return seedSession(
        project,
        "parent1",
        `${sessionId}.json`,
        sessionEnvelope(
          terminalSession(sessionId, iso(NOW - 8 * DAY_IN_MS), status),
        ),
      );
    });

    const result = await cleanup(project);

    expect(result.deletedPaths).toEqual([...paths].sort());
    expect(result.deletedCount).toBe(statuses.length);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a non-positive retention period without touching records", async () => {
    const project = freshProject();
    const path = seedSession(
      project,
      "parent1",
      "00000000-0000-0065.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0065", iso(NOW - 30 * DAY_IN_MS)),
      ),
    );
    await expect(cleanup(project, NOW, 0)).rejects.toThrow(
      /positive number of days/,
    );
    await expect(cleanup(project, NOW, Number.NaN)).rejects.toThrow(
      /positive number of days/,
    );
    expect(existsSync(path)).toBe(true);
  });

  it("rejects non-finite clocks before scanning or deleting", async () => {
    const project = freshProject();
    const path = seedSession(
      project,
      "parent1",
      "00000000-0000-0065.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0065", iso(NOW - 30 * DAY_IN_MS)),
      ),
    );
    const bytes = readFileSync(path, "utf8");
    await expect(cleanup(project, Number.NaN)).rejects.toThrow(
      /finite epoch milliseconds/,
    );
    await expect(cleanup(project, Number.POSITIVE_INFINITY)).rejects.toThrow(
      /finite epoch milliseconds/,
    );
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
});

describe("exemptions", () => {
  it("keeps old active records without normalizing them", async () => {
    const project = freshProject();
    const running = seedSession(
      project,
      "parent1",
      "00000000-0000-004e.json",
      sessionEnvelope(activeSession("00000000-0000-004e", "running")),
    );
    const queued = seedSession(
      project,
      "parent1",
      "00000000-0000-0043.json",
      sessionEnvelope(activeSession("00000000-0000-0043", "queued")),
    );
    const runningBytes = readFileSync(running, "utf8");
    const queuedBytes = readFileSync(queued, "utf8");

    const result = await cleanup(project);

    expect(result).toEqual({ deletedPaths: [], deletedCount: 0, warnings: [] });
    // Read-only inspection: no restart normalization was applied.
    expect(readFileSync(running, "utf8")).toBe(runningBytes);
    expect(readFileSync(queued, "utf8")).toBe(queuedBytes);
    expect(JSON.parse(runningBytes).data.status).toBe("running");
    expect(JSON.parse(runningBytes).data.completed_at).toBeUndefined();
  });

  it("preserves an active replacement made after initial expiry inspection", async () => {
    const project = freshProject();
    const parentSessionId = "parent1";
    const sessionId = "00000000-0000-0047";
    const path = seedSession(
      project,
      parentSessionId,
      `${sessionId}.json`,
      sessionEnvelope(terminalSession(sessionId, iso(NOW - 8 * DAY_IN_MS))),
    );
    const replacement = activeSession(sessionId);
    let replacementBytes = "";

    const result = await cleanupProjectHistory({
      ...project,
      historyRetentionDays: 7,
      nowMs: NOW,
      beforeFinalDelete: async (candidatePath) => {
        expect(candidatePath).toBe(path);
        await new RecordStore({ ...project, parentSessionId }).writeSession(
          replacement,
        );
        replacementBytes = readFileSync(
          sessionRecordPath({ ...project, parentSessionId, sessionId }),
          "utf8",
        );
      },
    });

    expect(result).toEqual({ deletedPaths: [], deletedCount: 0, warnings: [] });
    expect(readFileSync(path, "utf8")).toBe(replacementBytes);
    expect(JSON.parse(replacementBytes).data).toEqual(replacement);
  });

  it("preserves terminal records with future timestamps with a warning", async () => {
    const project = freshProject();
    const path = seedSession(
      project,
      "parent1",
      "00000000-0000-0020.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0020", iso(NOW + 60 * 60 * 1000)),
      ),
    );

    const result = await cleanup(project);

    expect(result.deletedPaths).toEqual([]);
    expect(result.warnings).toEqual([
      { path, message: RETENTION_WARNINGS.futureTimestamp },
    ]);
    expect(existsSync(path)).toBe(true);
  });
});

describe("project-wide scope", () => {
  it("cleans sessions across all valid parent namespaces", async () => {
    const project = freshProject();
    const expiredAt = iso(NOW - 8 * DAY_IN_MS);
    const paths = [
      seedSession(
        project,
        "parentA",
        "00000000-0000-0006.json",
        sessionEnvelope(terminalSession("00000000-0000-0006", expiredAt)),
      ),
      seedSession(
        project,
        "parentB",
        "00000000-0000-000e.json",
        sessionEnvelope(terminalSession("00000000-0000-000e", expiredAt)),
      ),
    ];
    const kept = seedSession(
      project,
      "parentB",
      "00000000-0000-0028.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0028", iso(NOW - DAY_IN_MS)),
      ),
    );

    const result = await cleanup(project);

    expect(result.deletedPaths).toEqual([...paths].sort());
    expect(result.deletedCount).toBe(paths.length);
    expect(result.warnings).toEqual([]);
    expect(existsSync(kept)).toBe(true);
  });

  it("ignores invalid namespaces without deleting or warning", async () => {
    const project = freshProject();
    const projectDir = projectDirForProject(project);
    // Invalid namespace names: spaces and punctuation.
    for (const bad of ["bad name!", "has space"]) {
      const dir = join(projectDir, bad, "sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "00000000-0000-000f.json"),
        JSON.stringify(
          sessionEnvelope(
            terminalSession("00000000-0000-000f", iso(NOW - 30 * DAY_IN_MS)),
          ),
        ),
        "utf8",
      );
    }

    const result = await cleanup(project);

    expect(result).toEqual({ deletedPaths: [], deletedCount: 0, warnings: [] });
    expect(readdirSync(projectDir).sort()).toEqual(["bad name!", "has space"]);
  });

  it("is silent for a missing project namespace", async () => {
    const result = await cleanup(freshProject());
    expect(result).toEqual({ deletedPaths: [], deletedCount: 0, warnings: [] });
  });

  it("loads nothing outside the sessions directory", async () => {
    const project = freshProject();
    const projectDir = projectDirForProject(project);
    const strayDir = join(projectDir, "parent1");
    mkdirSync(strayDir, { recursive: true });
    const stray = join(strayDir, "00000000-0000-0057.json");
    writeFileSync(
      stray,
      JSON.stringify(
        sessionEnvelope(
          terminalSession("00000000-0000-0057", iso(NOW - 30 * DAY_IN_MS)),
        ),
      ),
      "utf8",
    );

    const result = await cleanup(project);

    expect(result).toEqual({ deletedPaths: [], deletedCount: 0, warnings: [] });
    expect(existsSync(stray)).toBe(true);
  });
});

describe("invalid record preservation", () => {
  it("preserves corrupt, unknown-version, mismatched, and schema-invalid files with fixed warnings in lexical order", async () => {
    const project = freshProject();
    const dir = sessionRecordsDirForParentSession({
      ...project,
      parentSessionId: "parent1",
    });
    mkdirSync(dir, { recursive: true });
    const valid = terminalSession(
      "00000000-0000-003a",
      iso(NOW - 8 * DAY_IN_MS),
    );
    const write = (name: string, content: string): string => {
      const path = join(dir, name);
      writeFileSync(path, content, "utf8");
      return path;
    };
    // Created out of order to prove deterministic lexical diagnostics.
    const validPath = write(
      "00000000-0000-003a.json",
      JSON.stringify(sessionEnvelope(valid)),
    );
    const corrupt = write("00000000-0000-000e.json", `{corrupt ${SECRET}`);
    const unknownVersion = write(
      "00000000-0000-0011.json",
      JSON.stringify({
        version: 99,
        kind: "session",
        data: { ...valid, session_id: "00000000-0000-0011", output: SECRET },
      }),
    );
    const kindMismatch = write(
      "00000000-0000-0014.json",
      JSON.stringify({
        version: 1,
        kind: "workflow",
        data: { ...valid, session_id: "00000000-0000-0014", output: SECRET },
      }),
    );
    const idMismatch = write(
      "00000000-0000-0018.json",
      JSON.stringify(
        sessionEnvelope({
          ...valid,
          session_id: "00000000-0000-003e",
          output: SECRET,
        }),
      ),
    );
    const schemaInvalid = write(
      "00000000-0000-001c.json",
      JSON.stringify(
        sessionEnvelope({
          ...valid,
          session_id: "00000000-0000-001c",
          status: "completed",
          completed_at: undefined,
          output: SECRET,
        }),
      ),
    );

    const result = await cleanup(project);

    // Only the valid expired record is deleted; every invalid file survives.
    expect(result.deletedPaths).toEqual([validPath]);
    expect(result.deletedCount).toBe(1);
    expect(result.warnings).toEqual(
      [corrupt, unknownVersion, kindMismatch, idMismatch, schemaInvalid].map(
        (path) => ({
          path,
          message: RETENTION_WARNINGS.invalid,
        }),
      ),
    );
    for (const path of [
      corrupt,
      unknownVersion,
      kindMismatch,
      idMismatch,
      schemaInvalid,
    ]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.runIf(POSIX && NON_ROOT)(
    "preserves unreadable files with a warning without blocking siblings",
    async () => {
      const project = freshProject();
      const expired = seedSession(
        project,
        "parent1",
        "00000000-0000-0022.json",
        sessionEnvelope(
          terminalSession("00000000-0000-0022", iso(NOW - 8 * DAY_IN_MS)),
        ),
      );
      const blocked = seedSession(
        project,
        "parent1",
        "00000000-0000-0034.json",
        sessionEnvelope(
          terminalSession("00000000-0000-0034", iso(NOW - 8 * DAY_IN_MS)),
        ),
      );
      chmodSync(blocked, 0o000);
      try {
        const result = await cleanup(project);
        expect(result.deletedPaths).toEqual([expired]);
        expect(result.warnings).toEqual([
          { path: blocked, message: RETENTION_WARNINGS.unreadable },
        ]);
        expect(existsSync(blocked)).toBe(true);
      } finally {
        chmodSync(blocked, 0o600);
      }
    },
  );

  it("ignores non-lowercase-JSON, temp, and unrelated files while flagging unexpected .json directories", async () => {
    const project = freshProject();
    const dir = sessionRecordsDirForParentSession({
      ...project,
      parentSessionId: "parent1",
    });
    mkdirSync(dir, { recursive: true });
    const expired = seedSession(
      project,
      "parent1",
      "00000000-0000-0022.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0022", iso(NOW - 8 * DAY_IN_MS)),
      ),
    );
    const upper = join(dir, "00000000-0000-005f.JSON");
    writeFileSync(upper, "garbage", "utf8");
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "garbage", "utf8");
    const temp = join(dir, ".00000000-0000-0022.json.123.tmp");
    writeFileSync(temp, "stale temp", "utf8");
    const nested = join(dir, "00000000-0000-0059.json");
    mkdirSync(nested);

    const result = await cleanup(project);

    expect(result.deletedPaths).toEqual([expired]);
    expect(result.warnings).toEqual([
      { path: nested, message: RETENTION_WARNINGS.unreadable },
    ]);
    expect(existsSync(upper)).toBe(true);
    expect(existsSync(notes)).toBe(true);
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it.runIf(POSIX && NON_ROOT)(
    "hardens a restrictive records directory before deleting",
    async () => {
      const project = freshProject();
      const dir = sessionRecordsDirForParentSession({
        ...project,
        parentSessionId: "parent1",
      });
      const target = seedSession(
        project,
        "parent1",
        "00000000-0000-0058.json",
        sessionEnvelope(
          terminalSession("00000000-0000-0058", iso(NOW - 8 * DAY_IN_MS)),
        ),
      );
      chmodSync(dir, 0o555);

      const result = await cleanup(project);

      expect(result.deletedPaths).toEqual([target]);
      expect(result.deletedCount).toBe(1);
      expect(result.warnings).toEqual([]);
      expect(existsSync(target)).toBe(false);
    },
  );
});

describe("containment", () => {
  it.runIf(POSIX)(
    "never reads or deletes outside records through linked namespaces, directories, or files",
    async () => {
      const expired = terminalSession(
        "00000000-0000-003f",
        iso(NOW - 30 * DAY_IN_MS),
      );
      const bytes = JSON.stringify(sessionEnvelope(expired));

      for (const linkedComponent of ["namespace", "records", "file"] as const) {
        const project = freshProject();
        const projectDir = projectDirForProject(project);
        const namespaceDir = join(projectDir, "parent1");
        const recordsDir = join(namespaceDir, "sessions");
        const outside = join(
          tempRoots.at(-1) as string,
          `outside-${linkedComponent}`,
        );
        mkdirSync(outside, { recursive: true });
        const outsideRecord = join(outside, "00000000-0000-003f.json");
        writeFileSync(outsideRecord, bytes, "utf8");

        if (linkedComponent === "namespace") {
          const outsideRecords = join(outside, "sessions");
          mkdirSync(outsideRecords);
          const target = join(outsideRecords, "00000000-0000-003f.json");
          writeFileSync(target, bytes, "utf8");
          mkdirSync(projectDir, { recursive: true });
          symlinkSync(outside, namespaceDir, "dir");
        } else if (linkedComponent === "records") {
          mkdirSync(namespaceDir, { recursive: true });
          symlinkSync(outside, recordsDir, "dir");
        } else {
          mkdirSync(recordsDir, { recursive: true });
          symlinkSync(
            outsideRecord,
            join(recordsDir, "00000000-0000-003f.json"),
            "file",
          );
        }

        const result = await cleanup(project);
        expect(result.deletedCount).toBe(0);
        expect(result.warnings).not.toEqual([]);
        expect(readFileSync(outsideRecord, "utf8")).toBe(bytes);
        if (linkedComponent === "namespace") {
          expect(
            readFileSync(
              join(outside, "sessions", "00000000-0000-003f.json"),
              "utf8",
            ),
          ).toBe(bytes);
        }
      }
    },
  );

  it("keeps every deleted path under the state root", async () => {
    const project = freshProject();
    const root = `${stateRootForAgentDir(project.agentDir)}${sep}`;
    seedSession(
      project,
      "parent1",
      "00000000-0000-0006.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0006", iso(NOW - 8 * DAY_IN_MS)),
      ),
    );

    const result = await cleanup(project);

    expect(result.deletedPaths.length).toBe(1);
    for (const path of result.deletedPaths) {
      expect(path.startsWith(root)).toBe(true);
    }
  });

  it("rejects escape before unlink", () => {
    const root = stateRootForAgentDir(join("agent-root", "agent"));
    expect(() =>
      assertContained(
        root,
        join(root, "..", "evil.json"),
        "retention record path",
      ),
    ).toThrow(/escapes the state root/);
  });
});

describe("lifecycle hooks", () => {
  it("activation and post-settlement hooks delegate to the same project-wide cleanup with the effective config", async () => {
    const expiredAt = iso(NOW - 8 * DAY_IN_MS);
    const seedAll = (project: {
      agentDir: string;
      projectPath: string;
    }): string[] => [
      seedSession(
        project,
        "parent1",
        "00000000-0000-0006.json",
        sessionEnvelope(terminalSession("00000000-0000-0006", expiredAt)),
      ),
      seedSession(
        project,
        "parent2",
        "00000000-0000-000e.json",
        sessionEnvelope(terminalSession("00000000-0000-000e", expiredAt)),
      ),
    ];
    const config = Object.freeze({ ...DEFAULT_CONFIG });

    const forActivation = freshProject();
    const expectedActivation = seedAll(forActivation);
    const activationResult = await cleanupOnActivation({
      ...forActivation,
      config,
      nowMs: NOW,
    });

    const forSettlement = freshProject();
    const expectedSettlement = seedAll(forSettlement);
    const settlementResult = await cleanupAfterTerminalSettlement({
      ...forSettlement,
      config,
      nowMs: NOW,
    });

    // Both hooks delegate to the same project-wide implementation: identical
    // shapes with project-relative paths, differing only by project root.
    expect(activationResult.deletedPaths).toEqual(
      [...expectedActivation].sort(),
    );
    expect(settlementResult.deletedPaths).toEqual(
      [...expectedSettlement].sort(),
    );
    expect(settlementResult).toEqual({
      deletedPaths: [...expectedSettlement].sort(),
      deletedCount: 2,
      warnings: [],
    });
    expect(activationResult).toEqual({
      deletedPaths: [...expectedActivation].sort(),
      deletedCount: 2,
      warnings: [],
    });
  });

  it("hooks honor the effective historyRetentionDays", async () => {
    const completedAt = iso(NOW - 8 * DAY_IN_MS);
    const project = freshProject();
    seedSession(
      project,
      "parent1",
      "00000000-0000-002d.json",
      sessionEnvelope(terminalSession("00000000-0000-002d", completedAt)),
    );

    const kept = await cleanupOnActivation({
      ...project,
      config: Object.freeze({ ...DEFAULT_CONFIG, historyRetentionDays: 30 }),
      nowMs: NOW,
    });
    expect(kept).toEqual({ deletedPaths: [], deletedCount: 0, warnings: [] });

    const deleted = await cleanupAfterTerminalSettlement({
      ...project,
      config: Object.freeze({ ...DEFAULT_CONFIG, historyRetentionDays: 7 }),
      nowMs: NOW,
    });
    expect(deleted.deletedCount).toBe(1);
  });

  it("activation hook defaults its clock to the current time", async () => {
    const project = freshProject();
    const target = seedSession(
      project,
      "parent1",
      "00000000-0000-0035.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0035", iso(Date.now() - 8 * DAY_IN_MS)),
      ),
    );
    const result = await cleanupOnActivation({
      ...project,
      config: Object.freeze({ ...DEFAULT_CONFIG }),
    });
    expect(result.deletedPaths).toEqual([target]);
    expect(existsSync(target)).toBe(false);
  });

  it("extension activation awaits project-wide cleanup with the effective config", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-retention-boot-"));
    tempRoots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "work", "proj");
    const project = { agentDir, projectPath: cwd };
    const target = seedSession(
      project,
      "parent1",
      "00000000-0000-0010.json",
      sessionEnvelope(
        terminalSession("00000000-0000-0010", iso(Date.now() - 8 * DAY_IN_MS)),
      ),
    );

    const tools: ToolDefinition<string, unknown, unknown>[] = [];
    const pi = {
      registerTool: (tool: ToolDefinition<string, unknown, unknown>) => {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;
    await extension(pi, undefined, { agentDir, cwd });

    expect(tools).toHaveLength(4);
    expect(existsSync(target)).toBe(false);
  });
});
