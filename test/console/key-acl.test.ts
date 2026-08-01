import { describe, expect, test } from "bun:test";
import { filterModelsForKey, isModelAllowedForKey } from "../../src/console/key-acl";
import type { ApiKeyPublic } from "../../src/console/db/repos/api-keys";

function makeKey(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "key-1",
    name: "test-key",
    keyPrefix: "sk-test",
    active: true,
    rateLimitRpm: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: null,
    modelDenylist: null,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

describe("isModelAllowedForKey — exact-match semantics", () => {
  test("allowlisting a bare alias does not also allow the qualified provider model it resolves to", () => {
    const key = makeKey({ modelAllowlist: ["gpt-5.6-sol"] });
    expect(isModelAllowedForKey(key, "gpt-5.6-sol")).toBe(true);
    expect(isModelAllowedForKey(key, "openai/gpt-5.6-sol")).toBe(false);
  });

  test("allowlisting a qualified model does not also allow a same-named bare alias", () => {
    const key = makeKey({ modelAllowlist: ["openai/gpt-5.6-sol"] });
    expect(isModelAllowedForKey(key, "openai/gpt-5.6-sol")).toBe(true);
    expect(isModelAllowedForKey(key, "gpt-5.6-sol")).toBe(false);
  });

  test("denylisting a bare alias does not deny the qualified provider model it resolves to", () => {
    const key = makeKey({ modelDenylist: ["gpt-5.6-sol"] });
    expect(isModelAllowedForKey(key, "gpt-5.6-sol")).toBe(false);
    expect(isModelAllowedForKey(key, "openai/gpt-5.6-sol")).toBe(true);
  });

  test("provider allowlist still gates qualified models by provider prefix", () => {
    const key = makeKey({ providerAllowlist: ["kimchi"] });
    expect(isModelAllowedForKey(key, "kimchi/kimi-k2.7")).toBe(true);
    expect(isModelAllowedForKey(key, "cmd/gpt-5-codex")).toBe(false);
    // Bare aliases carry no provider prefix, so provider allowlist does not apply to them.
    expect(isModelAllowedForKey(key, "gpt-5.6-sol")).toBe(true);
  });

  test("no allowlist/denylist configured permits everything", () => {
    const key = makeKey();
    expect(isModelAllowedForKey(key, "gpt-5.6-sol")).toBe(true);
    expect(isModelAllowedForKey(key, "openai/gpt-5.6-sol")).toBe(true);
  });
});

describe("filterModelsForKey — /v1/models catalog filtering", () => {
  test("an allowlisted alias filters out its own qualified target, closing the /v1/models duplicate leak", () => {
    const key = makeKey({ modelAllowlist: ["gpt-5.6-sol"] });
    const catalog = [{ id: "gpt-5.6-sol" }, { id: "openai/gpt-5.6-sol" }, { id: "anthropic/claude-3" }];
    expect(filterModelsForKey(key, catalog).map((entry) => entry.id)).toEqual(["gpt-5.6-sol"]);
  });
});
