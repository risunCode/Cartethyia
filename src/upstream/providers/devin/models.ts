import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

const MODELS: ProviderModelEntry[] = [
  { id: "swe-1-6-slow", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Devin SWE 1.6 Slow (deep reasoning)" },
  { id: "swe-1-7-medium", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Devin SWE 1.7 Medium" },
];

export const devinModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);
