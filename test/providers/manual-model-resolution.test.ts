import { describe, expect, test } from "bun:test";
import { AgentRouterAdapter } from "../../src/providers/agentrouter";
import { AnthropicAdapter } from "../../src/providers/anthropic";
import { ClineAdapter } from "../../src/providers/cline";
import { OpenAIAdapter } from "../../src/providers/openai";
import { QoderAdapter } from "../../src/providers/qoder";

describe("manual model target resolution", () => {
  test("accepts operator-added IDs on curated providers", () => {
    const modelId = "nvidia/nemotron-3.5-lightning";
    const cases = [
      [new AgentRouterAdapter(), "anthropic-messages"],
      [new AnthropicAdapter(), "anthropic-messages"],
      [new ClineAdapter(), "openai-chat"],
      [new OpenAIAdapter(), "openai-responses"],
      [new QoderAdapter(), "openai-chat"],
    ] as const;

    for (const [adapter, surface] of cases) {
      expect(adapter.resolveTarget(modelId, surface)).toMatchObject({
        providerId: adapter.metadata.id,
        modelId,
        upstreamModelId: modelId,
        surface,
      });
    }
  });
});
