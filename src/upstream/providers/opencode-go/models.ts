import type { ProviderModelEntry } from "../models";

// Curated subset of the live Go catalog, the full, current list is always
// available via the console's "Fetch models" action. No pricing: this is
// OpenCode's own bundled subscription catalog, not raw per-token vendor
// pricing (each id is OpenCode's own re-branding, not a stable models.dev key).
export const opencodeGoModels: ProviderModelEntry[] = [
  { id: "grok-4.5", reasoning: true },
  { id: "glm-5.2", reasoning: true },
  { id: "kimi-k3", reasoning: true, vision: true },
  { id: "kimi-k2.7-code", reasoning: true },
  { id: "mimo-v2.5-pro", reasoning: true },
  { id: "qwen3.7-max", reasoning: true },
  { id: "minimax-m3", reasoning: true },
  { id: "deepseek-v4-pro", reasoning: true },
  { id: "deepseek-v4-flash", reasoning: true },
  { id: "hy3", reasoning: true },
];
