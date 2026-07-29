import { createModelCatalog, type ProviderModelCatalog } from "../models";

/**
 * Curated list for display only — routing accepts ANY model id, same as the
 * OpenAI built-in provider. Verified current lineup (2026):
 * Fable 5 (2026-06-09, top tier), Opus 5 (2026-07-24), Sonnet 5 (2026-06-30),
 * Haiku 4.5 (2025-10-15, latest confirmed Haiku).
 */
export const anthropicModelCatalog: ProviderModelCatalog = createModelCatalog([
  { id: "claude-fable-5", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 1000000, maxOutputTokens: 128000, description: "Most capable widely-released model — demanding reasoning, long-horizon agentic tasks." },
  { id: "claude-opus-5", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 1000000, maxOutputTokens: 128000, description: "Flagship Opus — long-running agents, complex document work." },
  { id: "claude-sonnet-5", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 1000000, maxOutputTokens: 128000, description: "Highly agentic — planning, tool use, autonomous operation." },
  { id: "claude-haiku-4-5", capabilities: ["text", "streaming", "json", "tools", "vision"], contextWindow: 200000, maxOutputTokens: 64000, description: "Fastest, most cost-efficient." },
]);
