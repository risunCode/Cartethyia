import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetCodeBuddyVersionCache,
  buildCodeBuddyUserAgent,
  getCodeBuddyVersion,
  resolveCodeBuddyVersion,
} from "../../../../src/providers/operations/client-versions";
import { jsonResponse } from "../../../helpers/sse-fixtures";


describe("CodeBuddy client version", () => {
  beforeEach(() => {
    _resetCodeBuddyVersionCache();
  });

  afterEach(() => {
    _resetCodeBuddyVersionCache();
  });

  test("pinned fallback is exported and used before discovery", () => {
    expect(getCodeBuddyVersion()).toBe(VERSION_SOURCES.codebuddy.fallback);
  });

  test("user agents carry the resolved version for both identities", () => {
    expect(buildCodeBuddyUserAgent("IDE", "9.9.9")).toBe("IDE/9.9.9 CodeBuddy/9.9.9");
    expect(buildCodeBuddyUserAgent("CLI", "9.9.9")).toBe("CLI/9.9.9 CodeBuddy/9.9.9");
  });

  test("resolves from the primary npm registry", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("registry.npmjs.org")
        ? jsonResponse({ version: "2.160.0" })
        : new Response("missing", { status: 404 })) as unknown as typeof fetch;

    await resolveCodeBuddyVersion(fetcher);
    expect(getCodeBuddyVersion()).toBe("2.160.0");
    expect(buildCodeBuddyUserAgent("CLI")).toBe("CLI/2.160.0 CodeBuddy/2.160.0");
  });

  test("falls back to the npmmirror secondary when the primary fails", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes("registry.npmjs.org")) {
        return new Response("boom", { status: 503 });
      }
      return jsonResponse({ version: "2.162.0" });
    }) as unknown as typeof fetch;

    await resolveCodeBuddyVersion(fetcher);
    expect(getCodeBuddyVersion()).toBe("2.162.0");
  });

  test("keeps the pinned fallback when every source fails", async () => {
    const fetcher = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    await resolveCodeBuddyVersion(fetcher);
    expect(getCodeBuddyVersion()).toBe(VERSION_SOURCES.codebuddy.fallback);
  });

  test("serves a cached result without re-fetching", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse({ version: "2.161.0" });
    }) as unknown as typeof fetch;

    await resolveCodeBuddyVersion(fetcher);
    await resolveCodeBuddyVersion(fetcher);
    expect(calls).toBe(1);
    expect(getCodeBuddyVersion()).toBe("2.161.0");
  });
});