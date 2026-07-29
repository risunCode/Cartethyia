import { createModelCatalog, type ProviderModelCatalog } from "../models";

/**
 * Curated list for display only — routing accepts ANY model id (built-in
 * API-key provider), since OpenAI's catalog moves faster than this list can.
 * GPT-5.6 family (Sol/Terra/Luna) released 2026-07-09; GPT-5.5 (2026-04) and
 * GPT-5.4 mini (2026-03-17) remain live in the API and are kept as prior-gen
 * options (developers.openai.com/api/docs/models).
 */
export const openaiModelCatalog: ProviderModelCatalog = createModelCatalog([
  { id: "gpt-5.6-sol", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 400000, maxOutputTokens: 128000, description: "Flagship — frontier coding, knowledge work, cybersecurity, science." },
  { id: "gpt-5.6-terra", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 400000, maxOutputTokens: 128000, description: "Balanced — lower cost per performance." },
  { id: "gpt-5.6-luna", capabilities: ["text", "streaming", "json", "tools", "reasoning"], contextWindow: 400000, maxOutputTokens: 128000, description: "Fastest, most cost-efficient tier." },
  { id: "gpt-5.5", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 1000000, maxOutputTokens: 128000, description: "Prior-gen frontier — complex professional and agentic work." },
  { id: "gpt-5.4-mini", capabilities: ["text", "streaming", "json", "tools", "reasoning", "vision"], contextWindow: 400000, maxOutputTokens: 128000, description: "Strongest mini tier — coding, computer use, high-volume subagents." },
]);
