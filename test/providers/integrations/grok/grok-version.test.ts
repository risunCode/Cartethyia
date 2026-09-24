import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetGrokVersionCache,
  buildGrokAuthUserAgent,
  buildGrokUserAgent,
  getGrokVersion,
  resolveGrokVersion,
} from "../../../../src/providers/operations/client-versions";
import { jsonResponse } from "../../../helpers/sse-fixtures";


function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

describe("Grok CLI client version", () => {
  beforeEach(() => {
    _resetGrokVersionCache();
  });

  afterEach(() => {
    _resetGrokVersionCache();
  });

  test("pinned fallback is exported and used before discovery", () => {
    expect(getGrokVersion()).toBe(VERSION_SOURCES.grok.fallback);
  });

  test("user agents compose from the resolved version", () => {
    expect(buildGrokUserAgent("9.9.9")).toBe("grok-shell/9.9.9 (linux; x86_64)");
    expect(buildGrokAuthUserAgent("9.9.9")).toBe(
      "grok-pager/9.9.9 grok-shell/9.9.9 (linux; x86_64)",
    );
  });

  test("resolves from the primary release pointer", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("storage.googleapis.com")
        ? textResponse("1.0.35\n")
        : new Response("missing", { status: 404 })) as unknown as typeof fetch;

    await resolveGrokVersion(fetcher);
    expect(getGrokVersion()).toBe("1.0.35");
    expect(buildGrokUserAgent()).toBe("grok-shell/1.0.35 (linux; x86_64)");
  });

  test("falls back to the npm dist-tag when the release pointer fails", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes("storage.googleapis.com")) {
        return new Response("boom", { status: 500 });
      }
      return jsonResponse({ version: "1.0.36" });
    }) as unknown as typeof fetch;

    await resolveGrokVersion(fetcher);
    expect(getGrokVersion()).toBe("1.0.36");
  });

  test("keeps the pinned fallback when every source fails", async () => {
    const fetcher = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    await resolveGrokVersion(fetcher);
    expect(getGrokVersion()).toBe(VERSION_SOURCES.grok.fallback);
  });

  test("ignores a non-semver upstream body", async () => {
    const fetcher = (async () =>
      textResponse("<html>nothing here</html>")) as unknown as typeof fetch;

    await resolveGrokVersion(fetcher);
    expect(getGrokVersion()).toBe(VERSION_SOURCES.grok.fallback);
  });

  test("serves a cached result without re-fetching", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return textResponse("1.0.37");
    }) as unknown as typeof fetch;

    await resolveGrokVersion(fetcher);
    await resolveGrokVersion(fetcher);
    expect(calls).toBe(1);
    expect(getGrokVersion()).toBe("1.0.37");
  });
});
