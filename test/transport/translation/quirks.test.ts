import { describe, expect, test } from "bun:test";
import { applyParamQuirks, findParamQuirk } from "../../../src/transport/translation/quirks";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

function requestWith(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-opus-4-5",
    stream: false,
    messages: [],
    generation_controls: {
      temperature: 0.7,
      max_tokens: 8192,
    },
    ...overrides,
  } as CanonicalRequest;
}

describe("applyParamQuirks", () => {
  test("strips temperature for anthropic claude models", () => {
    const request = requestWith();
    const next = applyParamQuirks(request, "anthropic");
    expect(next.generation_controls.temperature).toBeUndefined();
    expect(next.generation_controls.max_tokens).toBe(8192);
    // Original request untouched.
    expect(request.generation_controls.temperature).toBe(0.7);
  });

  test("leaves non-matching providers untouched", () => {
    const request = requestWith();
    expect(applyParamQuirks(request, "groq")).toBe(request);
  });

  test("model matcher limits the quirk to claude models", () => {
    const nonClaude = requestWith({ model: "gpt-5" });
    expect(applyParamQuirks(nonClaude, "anthropic")).toBe(nonClaude);
  });

  test("returns the original reference when nothing changed", () => {
    const noControls = requestWith({
      generation_controls: { max_tokens: 100 },
    });
    expect(applyParamQuirks(noControls, "anthropic")).toBe(noControls);
  });

  test("findParamQuirk matches provider and optional model regex", () => {
    expect(findParamQuirk("anthropic", "claude-sonnet-4-6")).toBeDefined();
    expect(findParamQuirk("anthropic", "gpt-5")).toBeUndefined();
    expect(findParamQuirk("zai", "claude-like-model")).toBeUndefined();
  });
});
