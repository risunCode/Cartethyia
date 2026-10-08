import { describe, expect, test } from "bun:test";
import { createClientVersionResolver } from "../../src/providers/operations/client-version-resolver";
import {
  _resetCodeBuddyCnVersionCache,
  _resetCodeBuddyVersionCache,
  buildCodeBuddyUserAgent,
  getCodeBuddyCnVersion,
  getCodeBuddyVersion,
  VERSION_SOURCES,
} from "../../src/providers/operations/client-versions";

describe("client version monitor snapshot", () => {
  test("starts on fallback and reports latest after background refresh", async () => {
    const resolver = createClientVersionResolver({
      key: `test-version-${crypto.randomUUID()}`,
      fallback: "1.0.0",
      sources: [{ url: "https://version.test/latest", extract: async () => "1.2.3" }],
      ttlMs: 1,
    });

    expect(resolver.snapshot()).toEqual({ version: "1.0.0", source: "fallback" });
    await resolver.ensure(async () => new Response("{}"));
    expect(resolver.snapshot()).toEqual({ version: "1.2.3", source: "latest" });
  });

  test("keeps CodeBuddy International and CN client identities separate", () => {
    expect(VERSION_SOURCES.codebuddy.fallback).toBe("2.161.2");
    expect(VERSION_SOURCES.codebuddyCn.fallback).toBe("4.12.1.39217423");
    expect(VERSION_SOURCES.codebuddy.sources[0]?.url).toContain("registry.npmjs.org");
    expect(VERSION_SOURCES.codebuddyCn.sources[0]?.url).toContain("codebuddy-cn.json");

    _resetCodeBuddyVersionCache("2.161.2");
    _resetCodeBuddyCnVersionCache("4.12.1.39217423");
    try {
      expect(getCodeBuddyVersion()).toBe("2.161.2");
      expect(getCodeBuddyCnVersion()).toBe("4.12.1.39217423");
      expect(buildCodeBuddyUserAgent("IDE")).toBe("IDE/2.161.2 CodeBuddy/2.161.2");
      expect(buildCodeBuddyUserAgent("CLI")).toBe("CLI/4.12.1.39217423 CodeBuddy/4.12.1.39217423");
    } finally {
      _resetCodeBuddyVersionCache();
      _resetCodeBuddyCnVersionCache();
    }
  });
});
