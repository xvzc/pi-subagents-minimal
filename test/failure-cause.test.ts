import { describe, expect, it } from "vitest";
import {
  classifyFailureCause,
  failureMessage,
} from "../src/runtime/failure-cause.js";

describe("failure cause classification", () => {
  it("maps recognizable provider causes to fixed categories", () => {
    expect(classifyFailureCause(new Error("401 Unauthorized"))).toBe(
      "authentication",
    );
    expect(classifyFailureCause("Incorrect API key provided")).toBe(
      "authentication",
    );
    expect(classifyFailureCause(new Error("invalid x-api-key"))).toBe(
      "authentication",
    );
    expect(classifyFailureCause("You didn't provide an API key")).toBe(
      "authentication",
    );
    expect(classifyFailureCause(new Error("Rate limit exceeded (429)"))).toBe(
      "rate_limit",
    );
    expect(classifyFailureCause(new Error("The request timed out"))).toBe(
      "timeout",
    );
    expect(classifyFailureCause(new Error("fetch failed"))).toBe("network");
    expect(classifyFailureCause(new Error("503 Service Unavailable"))).toBe(
      "overloaded",
    );
    expect(classifyFailureCause(new Error("context length exceeded"))).toBe(
      "context_length",
    );
    expect(classifyFailureCause(new Error("model not found"))).toBe(
      "model_not_found",
    );
    expect(classifyFailureCause(new Error("400 bad request"))).toBe(
      "invalid_request",
    );
    expect(classifyFailureCause(new Error("502 bad gateway"))).toBe(
      "server_error",
    );
  });

  it("walks bounded message and cause chains", () => {
    const wrapped = new Error("outer failure", {
      cause: new Error("fetch failed"),
    });
    expect(classifyFailureCause(wrapped)).toBe("network");
    expect(classifyFailureCause({ message: "rate limit reached" })).toBe(
      "rate_limit",
    );
  });

  it("falls back without echoing inspected text", () => {
    const secrets = [
      "OPENAI_API_KEY=sk-live-SECRET",
      "Authorization: Bearer sk-live-SECRET",
      "Cookie: session=SECRET",
      "Provider failed at /private/secret.ts:1:2",
    ];
    for (const secret of secrets) {
      expect(classifyFailureCause(new Error(secret))).toBeUndefined();
      expect(failureMessage("Base.", new Error(secret))).toBe("Base.");
    }
  });

  it("ignores bare status numbers in ambiguous text", () => {
    for (const text of [
      "401",
      "file 429 failed",
      "step 503 in local cleanup",
    ]) {
      expect(classifyFailureCause(text)).toBeUndefined();
      expect(failureMessage("Base.", text, "assistant_stop")).toBe("Base.");
    }
  });

  it("falls back when unknown getters or proxies throw", () => {
    const throwingMessage = {
      get message(): string {
        throw new Error("secret getter");
      },
    };
    const throwingCause = {
      message: "rate limit exceeded",
      get cause(): unknown {
        throw new Error("secret getter");
      },
    };
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("secret proxy");
        },
      },
    );
    for (const value of [throwingMessage, throwingCause, proxy]) {
      expect(classifyFailureCause(value)).toBeUndefined();
      expect(failureMessage("Base.", value, "assistant_stop")).toBe("Base.");
    }
  });

  it("uses model-request categories only for assistant stops", () => {
    expect(
      failureMessage(
        "Base.",
        new Error("429 Too Many Requests"),
        "assistant_stop",
      ),
    ).toBe("Base: the model request was rate-limited.");
    expect(failureMessage("Base.", new Error("rate limit exceeded"))).toBe(
      "Base.",
    );
    expect(failureMessage("Base", new Error("ECONNREFUSED"))).toBe(
      "Base: a network request failed.",
    );
  });
});
