import { describe, expect, test } from "bun:test";
import { createClientVersionResolver } from "../../src/providers/operations/client-version-resolver";

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
});
