import { createModelCatalog, type ProviderModelCatalog } from "../models";

export const cursorModelCatalog: ProviderModelCatalog = createModelCatalog([
  {
    id: "default",
    capabilities: ["text", "streaming", "json", "tools", "reasoning"],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    description: "Cursor Auto — server picks the best model for the request.",
  },
  {
    id: "composer-2.5",
    capabilities: ["text", "streaming", "json", "tools", "reasoning"],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    description: "Cursor Composer 2.5 — server picks the best model for the request.",
  },
  {
    id: "claude-4.6-sonnet",
    capabilities: ["text", "streaming", "json", "tools", "reasoning"],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    description: "Claude 4.6 Sonnet via Cursor.",
  },
  {
    id: "claude-4.6-opus",
    capabilities: ["text", "streaming", "json", "tools", "reasoning"],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    description: "Claude 4.6 Opus via Cursor.",
  },
  {
    id: "gpt-5.4-mini",
    capabilities: ["text", "streaming", "json", "tools", "reasoning"],
    contextWindow: 400000,
    maxOutputTokens: 64000,
    description: "GPT 5.4 Mini via Cursor.",
  },
  {
    id: "gpt-5.3-codex",
    capabilities: ["text", "streaming", "json", "tools", "reasoning"],
    contextWindow: 400000,
    maxOutputTokens: 64000,
    description: "GPT 5.3 Codex via Cursor.",
  },
]);
