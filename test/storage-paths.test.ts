/**
 * Storage path tests (S1-S3, A4 containment): stable canonical hashing with
 * no raw-path leakage, exact namespace layout, session separation,
 * parent/run validation including traversal rejection, and
 * resolved containment under the state root.
 */

import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertValidParentSessionId,
  assertValidSessionRunId,
  canonicalizeProjectPath,
  namespaceRootForParentSession,
  projectKeyForProjectPath,
  RECORD_FILE_EXTENSION,
  sessionRecordPath,
  sessionRecordsDirForParentSession,
  stateRootForAgentDir,
} from "../src/storage/paths.js";

const AGENT_DIR = join("agent-root", "agent");
const PROJECT_PATH = join("work", "project");
const PARENT = "parent123";

function namespace() {
  return {
    agentDir: AGENT_DIR,
    projectPath: PROJECT_PATH,
    parentSessionId: PARENT,
  };
}

describe("project keys", () => {
  it("is a stable 64-hex hash of the canonical path", () => {
    const first = projectKeyForProjectPath(PROJECT_PATH);
    const second = projectKeyForProjectPath(PROJECT_PATH);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaks no raw path characters", () => {
    const key = projectKeyForProjectPath(join("some", "deep", "project-dir"));
    expect(key).not.toContain("some");
    expect(key).not.toContain("project-dir");
    expect(key).not.toContain(sep);
    expect(key).not.toContain(".");
  });

  it("differs per project path", () => {
    expect(projectKeyForProjectPath(join("work", "a"))).not.toBe(
      projectKeyForProjectPath(join("work", "b")),
    );
  });

  it("treats lexical aliases as the same project", () => {
    const base = join("work", "project");
    expect(canonicalizeProjectPath(join("work", "sub", "..", "project"))).toBe(
      canonicalizeProjectPath(base),
    );
    expect(canonicalizeProjectPath(`${base}${sep}`)).toBe(
      canonicalizeProjectPath(base),
    );
    expect(canonicalizeProjectPath(join(".", base))).toBe(
      canonicalizeProjectPath(base),
    );
    expect(projectKeyForProjectPath(join("work", "sub", "..", "project"))).toBe(
      projectKeyForProjectPath(base),
    );
  });

  it("rejects empty project paths", () => {
    expect(() => projectKeyForProjectPath("")).toThrow(/project path/);
    expect(() => projectKeyForProjectPath("   ")).toThrow(/project path/);
  });
});

describe("namespace layout", () => {
  it("uses the exact <root>/<project-key>/<parent>/{sessions}/<run>.json layout", () => {
    const root = stateRootForAgentDir(AGENT_DIR);
    expect(root).toBe(join(resolve(AGENT_DIR), "subagents-state"));
    const key = projectKeyForProjectPath(PROJECT_PATH);
    const namespaceRoot = namespaceRootForParentSession(namespace());
    expect(namespaceRoot).toBe(join(root, key, PARENT));
    expect(
      sessionRecordPath({ ...namespace(), sessionId: "00000000-0000-0008" }),
    ).toBe(
      join(
        root,
        key,
        PARENT,
        "sessions",
        `00000000-0000-0008${RECORD_FILE_EXTENSION}`,
      ),
    );
    expect(RECORD_FILE_EXTENSION).toBe(".json");
  });

  it("places session records under the sessions directory", () => {
    const sessionsDir = sessionRecordsDirForParentSession(namespace());
    expect(sessionsDir.endsWith(`${sep}sessions`)).toBe(true);
    const sessionPath = sessionRecordPath({
      ...namespace(),
      sessionId: "00000000-0000-0052",
    });
    expect(sessionPath).toContain(`${sep}sessions${sep}`);
  });

  it("isolates parent-session namespaces", () => {
    const first = sessionRecordPath({
      ...namespace(),
      parentSessionId: "parentA",
      sessionId: "00000000-0000-0065",
    });
    const second = sessionRecordPath({
      ...namespace(),
      parentSessionId: "parentB",
      sessionId: "00000000-0000-0065",
    });
    expect(first).not.toBe(second);
  });
});

describe("parent-session validation", () => {
  it("accepts conservative single-segment IDs", () => {
    for (const id of [
      "abc",
      "A-_0",
      "00000000-0000-0041",
      "0abc",
      "parent123",
    ]) {
      expect(() => assertValidParentSessionId(id)).not.toThrow();
    }
  });

  it("rejects separators, traversal, NUL, and dot segments", () => {
    for (const id of [
      "",
      "a/b",
      "a\\b",
      "..",
      ".",
      ".hidden",
      "-leading",
      "_leading",
      "has space",
      "semi;colon",
      "a\0b",
      "a\nb",
      "../evil",
      "a..b/../c",
    ]) {
      expect(() => assertValidParentSessionId(id), id).toThrow(
        /parent session/i,
      );
    }
  });

  it("rejects overlong values", () => {
    expect(() => assertValidParentSessionId("a".repeat(129))).toThrow(
      /parent session/i,
    );
    expect(() => assertValidParentSessionId("a".repeat(128))).not.toThrow();
  });
});

describe("run ID validation", () => {
  it("accepts exact lowercase hexadecimal 8-4-4 IDs", () => {
    expect(() => assertValidSessionRunId("a1b2c3d4-e5f6-0718")).not.toThrow();
  });

  it("rejects malformed, path-unsafe, uppercase, and legacy IDs", () => {
    for (const id of [
      "",
      "a1b2c3d4e5f60718",
      "a1b2c3d4-e5f6-0718/other",
      "a1b2c3d4-e5f6-0718\\other",
      "A1b2c3d4-e5f6-0718",
      "ses_a1b2c3d4-e5f6-0718",
      "plain",
    ]) {
      expect(() => assertValidSessionRunId(id), id).toThrow();
    }
  });

  it("rejects traversal run IDs before joining", () => {
    expect(() =>
      sessionRecordPath({ ...namespace(), sessionId: "ses_../evil" }),
    ).toThrow();
    expect(() =>
      namespaceRootForParentSession({
        ...namespace(),
        parentSessionId: "../evil",
      }),
    ).toThrow();
  });
});

describe("containment", () => {
  it("keeps every constructed path under the resolved state root", () => {
    const root = resolve(stateRootForAgentDir(AGENT_DIR));
    const paths = [
      namespaceRootForParentSession(namespace()),
      sessionRecordsDirForParentSession(namespace()),
      sessionRecordPath({ ...namespace(), sessionId: "00000000-0000-0065" }),
    ];
    for (const path of paths) {
      expect(resolve(path).startsWith(root + sep)).toBe(true);
    }
  });
});
