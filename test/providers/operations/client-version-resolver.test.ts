import { describe, expect, test } from "bun:test";
import {
  createClientVersionResolver,
  isSemverish,
} from "../../../src/providers/operations/client-version-resolver";

/** Fake fetch that answers each URL from a map; records the urls it saw. */
function fakeFetch(responses: Record<string, string>): typeof fetch & { readonly urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    const body = responses[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { readonly urls: string[] };
  Object.defineProperty(impl, "urls", { get: () => urls });
  return impl;
}

const EXTENSION_URL = "https://raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json";
const NPM_URL = "https://registry.npmjs.org/cline/latest";

describe("createClientVersionResolver", () => {
  test("ignores a discovered version below minVersion", async () => {
    const fetcher = fakeFetch({
      [NPM_URL]: JSON.stringify({ version: "3.0.62" }),
    });
    const resolver = createClientVersionResolver({
      key: "test-cline-min",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      sources: [{ url: NPM_URL }],
    });

    await resolver.ensure(fetcher);
    // The registry published the CLI (3.x), not the artifact the API gates on
    // (4.x). Accepting it would downgrade the client and break every request.
    expect(resolver.get()).toBe("4.1.18");
  });

  test("accepts a discovered version at or above minVersion", async () => {
    const fetcher = fakeFetch({
      [EXTENSION_URL]: JSON.stringify({ version: "4.1.19" }),
      [NPM_URL]: JSON.stringify({ version: "3.0.62" }),
    });
    const resolver = createClientVersionResolver({
      key: "test-cline-upgrade",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      // Extension manifest first: it is the artifact the API gates on.
      sources: [{ url: EXTENSION_URL }, { url: NPM_URL }],
    });

    await resolver.ensure(fetcher);
    expect(resolver.get()).toBe("4.1.19");
    // The authoritative source answered, so the CLI registry is never probed.
    expect(fetcher.urls).toEqual([EXTENSION_URL]);
  });

  test("falls through to the next source when the first is below minVersion", async () => {
    const fetcher = fakeFetch({
      [NPM_URL]: JSON.stringify({ version: "3.0.62" }),
      [EXTENSION_URL]: JSON.stringify({ version: "4.2.0" }),
    });
    const resolver = createClientVersionResolver({
      key: "test-cline-fallthrough",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      sources: [{ url: NPM_URL }, { url: EXTENSION_URL }],
    });

    await resolver.ensure(fetcher);
    expect(resolver.get()).toBe("4.2.0");
  });

  test("falls back when every source fails", async () => {
    const resolver = createClientVersionResolver({
      key: "test-cline-offline",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      sources: [{ url: "https://example.invalid/latest" }],
    });
    await resolver.ensure(fakeFetch({}));
    expect(resolver.get()).toBe("4.1.18");
  });
});

describe("isSemverish", () => {
  test("accepts dotted triples and rejects the rest", () => {
    expect(isSemverish("4.1.19")).toBe(true);
    expect(isSemverish("1.0.0-rc.1")).toBe(true);
    expect(isSemverish("latest")).toBe(false);
    expect(isSemverish("")).toBe(false);
    expect(isSemverish(undefined)).toBe(false);
  });
});
