/**
 * Context-based diagnostics adapter tests (010 T3, A1, A3).
 *
 * Covers the safe UI warning adapter: warning-severity delivery, silent
 * drops for a missing or malformed UI, and synchronous notification failure
 * isolation with no console fallback (S2, S3, C3).
 */
import { describe, expect, it, vi } from "vitest";
import { notifyWarning } from "../src/diagnostics.js";

describe("UI warning adapter", () => {
  it("delivers one warning notification with warning severity", () => {
    const notify = vi.fn();
    notifyWarning({ notify } as never, "[pi-subagents-minimal] message.");
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "[pi-subagents-minimal] message.",
      "warning",
    );
  });

  it("silently drops warnings when the UI is missing or malformed", () => {
    expect(() => notifyWarning(undefined, "message")).not.toThrow();
    expect(() => notifyWarning({} as never, "message")).not.toThrow();
    expect(() =>
      notifyWarning({ notify: undefined } as never, "message"),
    ).not.toThrow();
  });

  it("swallows synchronous UI failures without console fallback", () => {
    const notify = vi.fn(() => {
      throw new Error("ui unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => notifyWarning({ notify } as never, "message")).not.toThrow();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
