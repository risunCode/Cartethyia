import { createOpenAICompatibleProvider } from "./openai-compatible";
import type { ProviderModelEntry } from "./models";

// Curated subset of the live Go catalog, the full, current list is always
// available via the console's "Fetch models" action. No pricing: this is
// OpenCode's own bundled subscription catalog, not raw per-token vendor
// pricing (each id is OpenCode's own re-branding, not a stable models.dev key).
export const opencodeGoModels: ProviderModelEntry[] = [
  { id: "grok-4.5", reasoning: true, contextWindow: 131072, maxOutputTokens: 16384, pricing: { input: 2, output: 6 } },
  { id: "glm-5.2", reasoning: true, contextWindow: 1000000, maxOutputTokens: 16384, pricing: { input: 1.4, output: 4.4 } },
  { id: "kimi-k3", reasoning: true, vision: true, contextWindow: 1000000, maxOutputTokens: 128000, pricing: { input: 3, output: 15 } },
  { id: "kimi-k2.7-code", reasoning: true, contextWindow: 262144, maxOutputTokens: 64000, pricing: { input: 0.95, output: 4 } },
  { id: "mimo-v2.5-pro", reasoning: true, contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: 0.435, output: 0.87 } },
  { id: "qwen3.7-max", reasoning: true, contextWindow: 1000000, maxOutputTokens: 16384, pricing: { input: 2.5, output: 7.5 } },
  { id: "minimax-m3", reasoning: true, contextWindow: 256000, maxOutputTokens: 32768, pricing: { input: 0.3, output: 1.2 } },
  { id: "deepseek-v4-pro", reasoning: true, contextWindow: 1000000, maxOutputTokens: 384000, pricing: { input: 0.435, output: 0.87 } },
  { id: "deepseek-v4-flash", reasoning: true, contextWindow: 1000000, maxOutputTokens: 384000, pricing: { input: 0.14, output: 0.28 } },
  { id: "hy3", reasoning: true, contextWindow: 262144, maxOutputTokens: 16384, pricing: { input: 0.14, output: 0.58 } },
];

export const opencodeGoProvider = createOpenAICompatibleProvider({
  id: "opencode-go",
  name: "OpenCode Go",
  icon: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  credentialUrl: "https://opencode.ai/auth",
  models: opencodeGoModels,
});
