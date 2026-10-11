import { describe, expect, test } from "bun:test";
import { createClientVersionResolver } from "../../src/providers/operations/client-version-resolver";
import {
  _resetCodeBuddyCnVersionCache,
  _resetCodeBuddyVersionCache,
  _resetClineClientVersionCache,
  buildCodeBuddyUserAgent,
  getCodeBuddyCnVersion,
  getCodeBuddyVersion,
  pinnedClientVersions,
  VERSION_SOURCES,
} from "../../src/providers/operations/client-versions";

describe("client version monitor snapshot", () => {
  test("starts on fallback and reports latest after background refresh", async () => {
    const resolver = createClientVersionResolver({
      key: `test-version-${crypto.randomUUID()}`,
      client: "test-client",
      fallback: "1.0.0",
      sources: [{ url: "https://version.test/latest", extract: async () => "1.2.3" }],
      ttlMs: 1,
    });

    expect(resolver.snapshot()).toEqual({ client: "test-client", version: "1.0.0", source: "fallback" });
    await resolver.ensure(async () => new Response("{}"));
    expect(resolver.snapshot()).toEqual({ client: "test-client", version: "1.2.3", source: "latest" });
  });

  test("keeps CodeBuddy International and CN client identities separate", () => {
    // Read the pins from the resolver's own declaration rather than restating
    // them: the assertion this test earns is that the two identities stay
    // distinct and independent, and a restated version number rots the moment
    // the pin is bumped without saying anything about the seam it guards.
    const international = VERSION_SOURCES.codebuddy.fallback;
    const cn = VERSION_SOURCES.codebuddyCn.fallback;
    expect(VERSION_SOURCES.codebuddy.sources[0]?.url).toContain("registry.npmjs.org");
    expect(VERSION_SOURCES.codebuddyCn.sources[0]?.url).toContain("codebuddy-cn.json");

    _resetCodeBuddyVersionCache(international);
    _resetCodeBuddyCnVersionCache(cn);
    try {
      expect(getCodeBuddyVersion()).toBe(international);
      expect(getCodeBuddyCnVersion()).toBe(cn);
      expect(buildCodeBuddyUserAgent("IDE")).toBe(`IDE/${international} CodeBuddy/${international}`);
      expect(buildCodeBuddyUserAgent("CLI")).toBe(`CLI/${cn} CodeBuddy/${cn}`);
    } finally {
      _resetCodeBuddyVersionCache();
      _resetCodeBuddyCnVersionCache();
    }
  });
});

describe("pinnedClientVersions", () => {
  // The report exists so an operator can see a stuck fallback *before* it
  // presents as an auth failure: Cline's refusal for an implausible client
  // identity is worded exactly like a dead credential. Two properties matter,
  // and a report that omits either is the false assurance the resolver's
  // `source` was written to prevent.
  test("a seeded version reads as latest and leaves the report", () => {
    // Discovery succeeded: nothing to warn about. This is the healthy answer,
    // and it is what stops the report from crying wolf on every client.
    _resetClineClientVersionCache("4.1.23");
    try {
      expect(pinnedClientVersions().some((p) => p.client === "cline")).toBe(false);
    } finally {
      _resetClineClientVersionCache();
    }
  });

  test("a fallback in force is reported with the version actually being sent", () => {
    // Resetting to null restores discovery behaviour, so the resolver is on its
    // fallback until the next background refresh — exactly the state an
    // operator must be able to see, with the number requests are carrying.
    _resetClineClientVersionCache(null);
    const entry = pinnedClientVersions().find((p) => p.client === "cline");
    expect(entry?.version).toBe(VERSION_SOURCES.clineClient.fallback);
  });

  test("the floor travels with a pinned fallback, because it explains which of two things happened", () => {
    // A pinned version means either discovery never answered, or it answered
    // with something below `minVersion` and was discarded. The second is the
    // interesting one — an artifact the provider does not gate on — and it is
    // indistinguishable from the first unless the floor is reported with it.
    _resetClineClientVersionCache(null);
    const entry = pinnedClientVersions().find((p) => p.client === "cline");
    expect(entry?.minVersion).toBe("4.1.23");
  });
});
