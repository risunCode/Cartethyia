import type { ProviderModelEntry } from "../models";

// Display-only, official BYOK provider, routing accepts any model id since
// OpenAI's catalog moves faster than a curated list can. Pricing/context/
// output verified against models.dev (openai) 2026-07-30.
export const openaiModels: ProviderModelEntry[] = [
  { id: "gpt-5.6-sol", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000, description: "Flagship, frontier coding, knowledge work, cybersecurity, science.", pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
  { id: "gpt-5.6-terra", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000, description: "Balanced, lower cost per performance.", pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 } },
  { id: "gpt-5.6-luna", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000, description: "Fastest, most cost-efficient tier.", pricing: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 } },
  { id: "gpt-5.5", reasoning: true, vision: true, contextWindow: 1050000, maxOutputTokens: 128000, description: "Prior-gen frontier, complex professional and agentic work.", pricing: { input: 5, output: 30, cacheRead: 0.5 } },
  { id: "gpt-5.4-mini", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 128000, description: "Strongest mini tier, coding, computer use, high-volume subagents.", pricing: { input: 0.75, output: 4.5, cacheRead: 0.075 } },
];
