import { describe, expect, test } from "bun:test";
import { resolveModelWireSurface } from "../../src/open-sse/translate";
import { CodexAdapter } from "../../src/providers/codex";

describe("Codex provider", () => {
  test("uses the Responses wire surface for chat and Responses clients", () => {
    const adapter = new CodexAdapter();
    const model = adapter.models.get("gpt-5.6-luna");

    expect(model).not.toBeNull();
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-chat")).toBe("openai-responses");
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-responses")).toBe("openai-responses");
  });

  test("resolves Luna against the Responses adapter contract", () => {
    const adapter = new CodexAdapter();

    expect(adapter.resolveTarget("gpt-5.6-luna", "openai-responses")).toEqual({
      providerId: "codex",
      modelId: "gpt-5.6-luna",
      upstreamModelId: "gpt-5.6-luna",
      surface: "openai-responses",
    });
  });
});
