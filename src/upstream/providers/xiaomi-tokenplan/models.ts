import type { ProviderModelEntry } from "../models";

// A flat subscription plan, not metered per token, hence $0 marginal cost
// below (verified against models.dev xiaomi-token-plan-sgp 2026-07-30).
// mimo-v2-omni and mimo-v2-pro were retired and are no longer offered on
// this tier.
export const xiaomiTokenPlanModels: ProviderModelEntry[] = [
  { id: "mimo-v2.5-pro", reasoning: true, contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: 0, output: 0 } },
  { id: "mimo-v2.5", reasoning: true, vision: true, contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: 0, output: 0 } },
];
