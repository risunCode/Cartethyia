import { describe, expect, test } from "bun:test";
import {
  boundedNumber,
  booleanOrUndefined,
  credentialKind,
  customProviderKind,
  proxyProtocol,
  sanitizeRuntimePatch,
  sanitizeKeyUpdate,
  sanitizeProviderRoutingPatch,
} from "../../src/console/input-sanitizers";

describe("boundedNumber", () => {
  test("returns a valid in-range number unchanged", () => {
    expect(boundedNumber(5, 0, 10)).toBe(5);
  });

  test("clamps a value below the minimum up to the minimum", () => {
    expect(boundedNumber(-3, 0, 10)).toBe(0);
  });

  test("clamps a value above the maximum down to the maximum", () => {
    expect(boundedNumber(42, 0, 10)).toBe(10);
  });

  test("rounds a fractional value to the nearest integer", () => {
    expect(boundedNumber(3.6, 0, 10)).toBe(4);
    expect(boundedNumber(3.4, 0, 10)).toBe(3);
  });

  test("rounds before clamping so a fractional value below min still hits the floor", () => {
    expect(boundedNumber(-0.7, 0, 10)).toBe(0);
  });

  test("returns undefined for NaN", () => {
    expect(boundedNumber(Number.NaN, 0, 10)).toBeUndefined();
  });

  test("returns undefined for Infinity", () => {
    expect(boundedNumber(Number.POSITIVE_INFINITY, 0, 10)).toBeUndefined();
    expect(boundedNumber(Number.NEGATIVE_INFINITY, 0, 10)).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(boundedNumber(undefined, 0, 10)).toBeUndefined();
  });

  test("returns undefined for non-number types", () => {
    expect(boundedNumber("5", 0, 10)).toBeUndefined();
    expect(boundedNumber(true, 0, 10)).toBeUndefined();
    expect(boundedNumber(null, 0, 10)).toBeUndefined();
  });

  test("respects an explicit zero boundary", () => {
    expect(boundedNumber(-1, 0, 0)).toBe(0);
    expect(boundedNumber(1, 0, 0)).toBe(0);
  });
});

describe("booleanOrUndefined", () => {
  test("returns true for boolean true", () => {
    expect(booleanOrUndefined(true)).toBe(true);
  });

  test("returns false for boolean false", () => {
    expect(booleanOrUndefined(false)).toBe(false);
  });

  test("returns undefined for the string \"true\"", () => {
    expect(booleanOrUndefined("true")).toBeUndefined();
  });

  test("returns undefined for the number 1", () => {
    expect(booleanOrUndefined(1)).toBeUndefined();
  });

  test("returns undefined for null and undefined", () => {
    expect(booleanOrUndefined(null)).toBeUndefined();
    expect(booleanOrUndefined(undefined)).toBeUndefined();
  });
});

describe("credentialKind", () => {
  test.each(["oauth", "manual", "api_key"] as const)("accepts the valid kind \"%s\"", (kind) => {
    expect(credentialKind(kind)).toBe(kind);
  });

  test("defaults to api_key for an invalid kind", () => {
    expect(credentialKind("none")).toBe("api_key");
  });

  test("defaults to api_key for a non-string value", () => {
    expect(credentialKind(42)).toBe("api_key");
    expect(credentialKind(null)).toBe("api_key");
    expect(credentialKind(undefined)).toBe("api_key");
  });
});

describe("customProviderKind", () => {
  test.each(["anthropic", "openai-compatible"] as const)("accepts the valid kind \"%s\"", (kind) => {
    expect(customProviderKind(kind)).toBe(kind);
  });

  test("defaults to openai for an unrecognized kind", () => {
    expect(customProviderKind("gemini")).toBe("openai");
  });

  test("defaults to openai for a non-string value", () => {
    expect(customProviderKind(123)).toBe("openai");
    expect(customProviderKind(null)).toBe("openai");
  });
});

describe("proxyProtocol", () => {
  test.each(["http", "https", "socks5"] as const)("accepts the valid protocol \"%s\"", (protocol) => {
    expect(proxyProtocol(protocol)).toBe(protocol);
  });

  test("returns null for an invalid protocol", () => {
    expect(proxyProtocol("ftp")).toBeNull();
    expect(proxyProtocol("socks4")).toBeNull();
  });

  test("returns null for a non-string value", () => {
    expect(proxyProtocol(8080)).toBeNull();
    expect(proxyProtocol(null)).toBeNull();
    expect(proxyProtocol(undefined)).toBeNull();
  });
});

describe("sanitizeRuntimePatch", () => {
  test("accepts every recognized field and coerces numeric and boolean values", () => {
    const patch = sanitizeRuntimePatch({
      proxyAuthMode: "api_key",
      privacyMode: "full",
      trackPayloads: "meta",
      trackAssets: "store",
      logRetentionDays: 7.9,
      assetRetentionDays: 3.1,
      maxFlightsPerIp: 5.9,
      sessionTtlHours: 2.5,
      trustProxy: true,
      cacheMarkersEnabled: false,
      sidebarIconDataUrl: "data:image/png;base64,abc",
      tokenSaverEnabled: true,
      tokenSaverQuality: "extreme",
      filterRulesEnabled: true,
    });
    expect(patch).toMatchObject({
      proxyAuthMode: "api_key",
      privacyMode: "full",
      trackPayloads: "meta",
      trackAssets: "store",
      logRetentionDays: 7,
      assetRetentionDays: 3,
      maxFlightsPerIp: 5,
      sessionTtlHours: 2,
      trustProxy: true,
      cacheMarkersEnabled: false,
      sidebarIconDataUrl: "data:image/png;base64,abc",
      tokenSaverEnabled: true,
      tokenSaverQuality: "extreme",
      filterRulesEnabled: true,
    });
  });

  test("drops unknown fields entirely", () => {
    const patch = sanitizeRuntimePatch({ rogueField: "nope", isAdmin: true });
    expect(patch).toEqual({});
  });

  test("drops invalid enum values, keeping valid ones in the same patch", () => {
    const patch = sanitizeRuntimePatch({
      proxyAuthMode: "invalid",
      privacyMode: "masked",
      trackAssets: "store-and-more",
      tokenSaverQuality: "ultra",
    });
    expect(patch.proxyAuthMode).toBeUndefined();
    expect(patch.privacyMode).toBe("masked");
    expect(patch.trackAssets).toBeUndefined();
    expect(patch.tokenSaverQuality).toBeUndefined();
  });

  test("clamps logRetentionDays to a minimum of 0", () => {
    expect(sanitizeRuntimePatch({ logRetentionDays: -5 }).logRetentionDays).toBe(0);
  });

  test("clamps maxFlightsPerIp to a minimum of 1", () => {
    expect(sanitizeRuntimePatch({ maxFlightsPerIp: -3 }).maxFlightsPerIp).toBe(1);
  });

  test("clamps sessionTtlHours to a minimum of 1", () => {
    expect(sanitizeRuntimePatch({ sessionTtlHours: 0 }).sessionTtlHours).toBe(1);
  });

  test("drops non-finite numeric values", () => {
    const patch = sanitizeRuntimePatch({
      logRetentionDays: Number.NaN,
      assetRetentionDays: Number.POSITIVE_INFINITY,
      maxFlightsPerIp: "not-a-number",
    });
    expect(patch.logRetentionDays).toBeUndefined();
    expect(patch.assetRetentionDays).toBeUndefined();
    expect(patch.maxFlightsPerIp).toBeUndefined();
  });

  test("accepts null for sidebarIconDataUrl (clearing the icon)", () => {
    expect(sanitizeRuntimePatch({ sidebarIconDataUrl: null }).sidebarIconDataUrl).toBeNull();
  });

  test("drops non-boolean trustProxy without polluting the patch", () => {
    expect(sanitizeRuntimePatch({ trustProxy: "yes" }).trustProxy).toBeUndefined();
  });

  test("returns an empty patch for an object with no recognized fields", () => {
    expect(sanitizeRuntimePatch({})).toEqual({});
  });
});

describe("sanitizeKeyUpdate", () => {
  test("accepts a valid custom key and forwards nullable limit fields", () => {
    const patch = sanitizeKeyUpdate({
      key: "valid-key-123",
      rateLimitRpm: 60,
      dailyTokenLimit: 100_000,
      monthlyTokenLimit: 1_000_000,
      oneTimeTokenLimit: 50,
      maxConcurrentRequests: 5,
      providerAllowlist: ["openai", "anthropic"],
      modelAllowlist: ["gpt-5"],
      modelDenylist: ["banned-model"],
      quoteBigText: "big",
      quoteSubText: "sub",
      quoteBody: "body",
      active: false,
    });
    expect(patch).toMatchObject({
      key: "valid-key-123",
      rateLimitRpm: 60,
      dailyTokenLimit: 100_000,
      monthlyTokenLimit: 1_000_000,
      oneTimeTokenLimit: 50,
      maxConcurrentRequests: 5,
      providerAllowlist: ["openai", "anthropic"],
      modelAllowlist: ["gpt-5"],
      modelDenylist: ["banned-model"],
      quoteBigText: "big",
      quoteSubText: "sub",
      quoteBody: "body",
      active: false,
    });
  });

  test("rejects a custom key shorter than 8 characters", () => {
    expect(sanitizeKeyUpdate({ key: "short" }).key).toBeUndefined();
  });

  test("rejects a custom key with disallowed characters", () => {
    expect(sanitizeKeyUpdate({ key: "has spaces!" }).key).toBeUndefined();
  });

  test("floors fractional limits to integers", () => {
    expect(sanitizeKeyUpdate({ rateLimitRpm: 60.9 }).rateLimitRpm).toBe(60);
  });

  test("rejects zero or negative limits by dropping them", () => {
    expect(sanitizeKeyUpdate({ rateLimitRpm: 0 }).rateLimitRpm).toBeUndefined();
    expect(sanitizeKeyUpdate({ dailyTokenLimit: -10 }).dailyTokenLimit).toBeUndefined();
  });

  test("accepts null to explicitly clear a limit", () => {
    expect(sanitizeKeyUpdate({ rateLimitRpm: null }).rateLimitRpm).toBeNull();
  });

  test("accepts null to explicitly clear an allowlist", () => {
    expect(sanitizeKeyUpdate({ providerAllowlist: null }).providerAllowlist).toBeNull();
  });

  test("filters non-string entries out of a list field", () => {
    expect(sanitizeKeyUpdate({ providerAllowlist: ["openai", 42, "anthropic"] }).providerAllowlist).toEqual(["openai", "anthropic"]);
  });

  test("accepts null to explicitly clear quote text", () => {
    expect(sanitizeKeyUpdate({ quoteBigText: null }).quoteBigText).toBeNull();
  });

  test("drops a non-boolean active flag", () => {
    expect(sanitizeKeyUpdate({ active: "true" }).active).toBeUndefined();
  });

  test("drops unknown fields entirely", () => {
    const patch = sanitizeKeyUpdate({ unknownField: true });
    expect(patch).toEqual({});
  });
});

describe("sanitizeProviderRoutingPatch", () => {
  test("accepts valid strategy, stickyLimit, and useStickyLimit fields", () => {
    const patch = sanitizeProviderRoutingPatch({ strategy: "round-robin", stickyLimit: 3.9, useStickyLimit: true });
    expect(patch).toMatchObject({
      strategy: "round-robin",
      stickyLimit: 3,
      useStickyLimit: true,
    });
  });

  test("accepts the priority strategy", () => {
    expect(sanitizeProviderRoutingPatch({ strategy: "priority" }).strategy).toBe("priority");
  });

  test("drops an invalid strategy", () => {
    expect(sanitizeProviderRoutingPatch({ strategy: "random" }).strategy).toBeUndefined();
  });

  test("clamps stickyLimit to a minimum of 0 and floors fractions", () => {
    expect(sanitizeProviderRoutingPatch({ stickyLimit: -1 }).stickyLimit).toBe(0);
    expect(sanitizeProviderRoutingPatch({ stickyLimit: 2.7 }).stickyLimit).toBe(2);
  });

  test("drops non-finite stickyLimit values", () => {
    expect(sanitizeProviderRoutingPatch({ stickyLimit: Number.NaN }).stickyLimit).toBeUndefined();
  });

  test("drops a non-boolean useStickyLimit", () => {
    expect(sanitizeProviderRoutingPatch({ useStickyLimit: "yes" }).useStickyLimit).toBeUndefined();
  });

  test("returns an empty patch for null input", () => {
    expect(sanitizeProviderRoutingPatch(null)).toEqual({});
  });

  test("returns an empty patch for non-object input", () => {
    expect(sanitizeProviderRoutingPatch("not-an-object")).toEqual({});
  });
});
