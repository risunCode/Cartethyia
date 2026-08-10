import { describe, expect, test } from "bun:test";
import { resolveModelWireSurface } from "../open-sse/translate";
import { AnthropicAdapter } from "./anthropic";

describe("Anthropic model surface routing", () => {
  test("translates OpenAI client surfaces onto the Anthropic Messages wire", () => {
    const adapter = new AnthropicAdapter();
    const model = adapter.models.get("claude-opus-4-1");

    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-chat")).toBe("anthropic-messages");
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "openai-responses")).toBe("anthropic-messages");
    expect(resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, "anthropic-messages")).toBe("anthropic-messages");
  });
});
