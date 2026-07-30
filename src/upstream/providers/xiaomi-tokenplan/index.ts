import { createOpenAICompatibleProvider } from "../openai-compatible";
import { xiaomiTokenPlanModels } from "./models";

/**
 * Xiaomi MiMo, Token Plan tier. Token Plan keys are cluster-specific;
 * Singapore is the default region (matches the reference registry).
 * Operators on a different region can reach it via a Custom Provider entry
 * pointed at their cluster's base URL.
 */
export const xiaomiTokenPlanProvider = createOpenAICompatibleProvider({
  id: "tpxiaomi",
  name: "Xiaomi MiMo (Token Plan)",
  icon: "mimo",
  baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
  credentialUrl: "https://mimo.xiaomi.com",
  models: xiaomiTokenPlanModels,
});
