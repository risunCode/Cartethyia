import { describe, expect, test } from "bun:test";
import { buildPayload, kiroProvider } from "../../../src/upstream/providers/kiro";
import { parseQualifiedModel } from "../../../src/routing/resolve";

describe("Kiro provider", () => {
  test("publishes Kiro models and route prefix", () => {
    expect(kiroProvider.models.resolve("claude-opus-4.8")).toBeDefined();
    expect(kiroProvider.models.resolve("gpt-5.6-luna-thinking-agentic")).toBeDefined();
    expect(parseQualifiedModel("kiro/claude-opus-4.8")).toEqual({ kind: "qualified", model: { provider: "kiro", modelId: "claude-opus-4.8" } });
  });

  test("translates chat history into Kiro conversation state", () => {
    const payload = buildPayload({ messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "continue" }], max_tokens: 256 }, "claude-opus-4.8");
    const state = payload.conversationState as Record<string, unknown>;
    expect(state.agentTaskType).toBe("vibe");
    expect((state.history as unknown[]).length).toBe(2);
    expect((state.currentMessage as Record<string, unknown>).userInputMessage).toMatchObject({ content: "continue", modelId: "claude-opus-4.8" });
    expect(payload.inferenceConfig).toMatchObject({ maxTokens: 256 });
  });
});
