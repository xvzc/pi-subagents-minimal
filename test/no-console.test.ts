/**
 * Production output-surface scan (010 T3, S1, A1, N5).
 *
 * Scans every production TypeScript file under `src/` and fails on any
 * prohibited diagnostics surface: `console.*` calls or direct writes to
 * process stdout/stderr. User-visible warnings must only leave through the
 * host UI adapter (`notifyWarning`), which never writes to the terminal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROHIBITED =
  /\bconsole\.(log|warn|error|info|debug|trace)\b|\bprocess\.(stdout|stderr)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}

const fileNames = sourceFiles(new URL("../src", import.meta.url).pathname);
expect(fileNames.length).toBeGreaterThan(0);

describe("production diagnostics surface (A1)", () => {
  it("never writes diagnostics through the console or process stdio", () => {
    for (const file of fileNames) {
      expect(
        readFileSync(file, "utf-8"),
        `${file} must not use console or process stdio`,
      ).not.toMatch(PROHIBITED);
    }
  });
});
