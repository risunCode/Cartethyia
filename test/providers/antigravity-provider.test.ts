import { describe, expect, test } from "bun:test";
import { AntigravityAdapter, antigravityWireModelId } from "../../src/providers/antigravity";

describe("Antigravity model catalog", () => {
  test("deduplicates display models while preserving upstream aliases", () => {
    const adapter = new AntigravityAdapter();

    expect(adapter.models.list.map((model) => model.id)).toEqual([
      "gemini-3.1-pro",
      "gemini-3.5-flash",
      "gemini-3-flash",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b",
    ]);
    expect(adapter.resolveTarget("gemini-3.1-pro", "openai-chat").upstreamModelId).toBe("gemini-pro-agent");
    expect(adapter.resolveTarget("gpt-oss-120b", "openai-chat").upstreamModelId).toBe("gpt-oss-120b-medium");
  });

  test("keeps wire aliases compatible with direct logical model requests", () => {
    expect(antigravityWireModelId("gemini-3.1-pro")).toBe("gemini-pro-agent");
    expect(antigravityWireModelId("gemini-3.5-flash")).toBe("gemini-3.5-flash-extra-low");
    expect(antigravityWireModelId("gpt-oss-120b")).toBe("gpt-oss-120b-medium");
  });
});
