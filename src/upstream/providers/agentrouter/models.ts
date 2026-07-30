import { createModelCatalog, type ProviderModelCatalog } from "../models";

/**
 * Curated display list — AgentRouter is a passthrough gateway (any
 * upstream-supported model id routes), this is just what shows in the
 * console. Matches the reference registry's model list.
 */
export const agentRouterModelCatalog: ProviderModelCatalog = createModelCatalog([
  { id: "claude-opus-4-6", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, pricing: { input: 5, output: 25 } },
  { id: "claude-opus-4-7", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, pricing: { input: 5, output: 25 } },
  { id: "claude-opus-4-8", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, pricing: { input: 5, output: 25 } },
  { id: "glm-5.2", reasoning: true, contextWindow: 1000000, maxOutputTokens: 16384, pricing: { input: 1.4, output: 4.4 } },
  { id: "gpt-5.5", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 128000, pricing: { input: 5, output: 30 } },
  { id: "kimi-k3", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 128000, pricing: { input: 3, output: 15 } },
]);
