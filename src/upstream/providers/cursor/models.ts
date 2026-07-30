import { createModelCatalog, type ProviderModelCatalog } from "../models";

export const cursorModelCatalog: ProviderModelCatalog = createModelCatalog([
  { id: "default", reasoning: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Cursor Auto, server picks the best model for the request." },
  { id: "composer-2.5", reasoning: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Cursor Composer 2.5, server picks the best model for the request." },
  { id: "claude-4.6-sonnet", reasoning: true, contextWindow: 200000, maxOutputTokens: 64000, pricing: { input: 3, output: 15 }, description: "Claude 4.6 Sonnet via Cursor." },
  { id: "claude-4.6-opus", reasoning: true, contextWindow: 200000, maxOutputTokens: 64000, pricing: { input: 5, output: 25 }, description: "Claude 4.6 Opus via Cursor." },
  { id: "gpt-5.4-mini", reasoning: true, contextWindow: 400000, maxOutputTokens: 64000, pricing: { input: 0.75, output: 4.5 }, description: "GPT 5.4 Mini via Cursor." },
  { id: "gpt-5.3-codex", reasoning: true, contextWindow: 400000, maxOutputTokens: 64000, pricing: { input: 2, output: 10 }, description: "GPT 5.3 Codex via Cursor." },
]);
