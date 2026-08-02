import { createModelCatalog, type ProviderModelCatalog } from "./models";

export const anthropicModelCatalog: ProviderModelCatalog = createModelCatalog([
  { id: "claude-fable-5", reasoning: true, vision: true, contextWindow: 1000000, maxOutputTokens: 128000, description: "Most capable widely-released model, demanding reasoning, long-horizon agentic tasks.", pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  { id: "claude-opus-5", reasoning: true, vision: true, contextWindow: 1000000, maxOutputTokens: 128000, description: "Flagship Opus, long-running agents, complex document work.", pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { id: "claude-sonnet-5", reasoning: true, vision: true, contextWindow: 1000000, maxOutputTokens: 128000, description: "Highly agentic, planning, tool use, autonomous operation.", pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: "claude-haiku-4-5", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Fastest, most cost-efficient.", pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
]);
