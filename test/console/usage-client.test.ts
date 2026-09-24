import { describe, expect, test } from "bun:test";
import { clientNameFromUserAgent } from "../../src/console/domains/stats/store";

describe("clientNameFromUserAgent", () => {
  test("reports the client product token with its version", () => {
    expect(clientNameFromUserAgent("cursor/1.2.3")).toBe("cursor/1.2.3");
    expect(clientNameFromUserAgent("Cline/3.0.58")).toBe("Cline/3.0.58");
    expect(clientNameFromUserAgent("codex-cli/0.1.0")).toBe("codex-cli/0.1.0");
    expect(clientNameFromUserAgent("claude-code/2.0")).toBe("claude-code/2.0");
    expect(clientNameFromUserAgent("bun/1.2.3")).toBe("bun/1.2.3");
    expect(clientNameFromUserAgent("curl/8.0")).toBe("curl/8.0");
  });

  test("falls back to Browser for Mozilla agents", () => {
    expect(clientNameFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Browser");
  });
  test("falls back to the first token with its version", () => {
    expect(clientNameFromUserAgent("my-internal-tool/9")).toBe("my-internal-tool/9");
  });

  test("returns unknown for missing agents", () => {
    expect(clientNameFromUserAgent(undefined)).toBe("unknown");
    expect(clientNameFromUserAgent("")).toBe("unknown");
  });
});
