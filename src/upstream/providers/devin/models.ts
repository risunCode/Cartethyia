import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

const REASONING_VISION: ProviderModelEntry["capabilities"] = ["text", "vision", "reasoning", "streaming", "json", "tools"];

const MODELS: ProviderModelEntry[] = [
  {
    id: "swe-1-6-slow",
    capabilities: REASONING_VISION,
    contextWindow: 200000,
    maxOutputTokens: 64000,
    description: "Devin SWE 1.6 Slow (deep reasoning)",
  },
  {
    id: "swe-1-7-medium",
    capabilities: REASONING_VISION,
    contextWindow: 200000,
    maxOutputTokens: 64000,
    description: "Devin SWE 1.7 Medium",
  },
];

export const devinModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);