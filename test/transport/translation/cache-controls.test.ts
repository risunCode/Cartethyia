import { describe, expect, it } from "bun:test";
import { anthropicCacheControl, type AnthropicCacheControl } from "../../../src/transport/translation/cache-controls";
import type { CacheHint } from "../../../src/transport/canonical-model";

describe("cache control payloads", () => {
// ============================================================================
// Anthropic Cache Control Tests
// ============================================================================

describe("anthropicCacheControl", () => {
  it("emits ephemeral cache_control for stable_prefix", () => {
    const result = anthropicCacheControl("stable_prefix");
    const payload = result as Record<string, AnthropicCacheControl>;

    expect(payload).toHaveProperty("cache_control");
    expect(payload.cache_control?.type).toBe("ephemeral");
  });

  it("omits ttl when not specified", () => {
    const result = anthropicCacheControl("stable_prefix");
    const payload = result as Record<string, AnthropicCacheControl>;

    expect(payload.cache_control?.ttl).toBeUndefined();
  });

  it("includes ttl: 5m when requested", () => {
    const result = anthropicCacheControl("stable_prefix", { ttl: "5m" });
    const payload = result as Record<string, AnthropicCacheControl>;

    expect(payload.cache_control?.ttl).toBe("5m");
  });

  it("includes ttl: 1h when requested (long-lived breakpoint)", () => {
    const result = anthropicCacheControl("stable_prefix", { ttl: "1h" });
    const payload = result as Record<string, AnthropicCacheControl>;

    expect(payload.cache_control?.ttl).toBe("1h");
  });

  it("has no scope field: Anthropic documents no scope option", () => {
    const result = anthropicCacheControl("stable_prefix");
    const payload = result as Record<string, AnthropicCacheControl>;

    expect(payload.cache_control?.type).toBe("ephemeral");
    expect("scope" in (payload.cache_control ?? {})).toBe(false);
  });

  it("handles undefined cache hint", () => {
    const result = anthropicCacheControl(undefined);
    const payload = result as Record<string, AnthropicCacheControl>;

    expect(payload.cache_control?.type).toBe("ephemeral");
  });

  it("handles breakpoint cache hint", () => {
    const hint: CacheHint = { kind: "breakpoint", list: [10, 20, 30] };
    const result = anthropicCacheControl(hint);
    const payload = result as Record<string, AnthropicCacheControl>;

    expect(payload.cache_control?.type).toBe("ephemeral");
  });

  it("preserves cache_control structure with breakpoints", () => {
    const hint: CacheHint = { kind: "breakpoint", list: [5, 15] };
    const result = anthropicCacheControl(hint, { ttl: "1h" });

    expect(result).toHaveProperty("cache_control");
    const control = result.cache_control as unknown;
    expect(typeof control === "object" && control !== null).toBe(true);
  });

  it("exact payload shape for Anthropic", () => {
    const result = anthropicCacheControl("stable_prefix", { ttl: "5m" });

    // Check exact structure
    expect(Object.keys(result)).toContain("cache_control");
    const control = result.cache_control as unknown;
    expect(typeof control === "object" && control !== null).toBe(true);
    const typed = control as Record<string, unknown>;
    expect(typed.type).toBe("ephemeral");
    expect(typed.ttl).toBe("5m");
  });
});

// ============================================================================
// Cross-Provider Integration Tests
// ============================================================================

describe("Provider payload shape integration", () => {
  it("Anthropic payload is self-contained", () => {
    const payload = anthropicCacheControl("stable_prefix", { ttl: "1h" });

    // Anthropic payload should only contain cache_control at top level
    expect(Object.keys(payload)).toContain("cache_control");
    expect(Object.keys(payload)).not.toContain("prompt_cache_options");
  });
});
});
