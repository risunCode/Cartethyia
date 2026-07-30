import { createOpenAICompatibleProvider } from "../openai-compatible";
import { xiaomiPaygModels } from "./models";

/**
 * Xiaomi MiMo, pay-as-you-go tier. Strict: gated to exactly the curated
 * pair in `./models.ts` per operator preference, unlike most entries in
 * `openai-compatible.ts` an unlisted model id here must be rejected rather
 * than routed through.
 */
export const xiaomiPaygProvider = createOpenAICompatibleProvider({
  id: "pgxiaomi",
  name: "Xiaomi MiMo (PAYG)",
  icon: "mimo",
  baseUrl: "https://api.xiaomimimo.com/v1",
  credentialUrl: "https://xiaomimimo.com",
  authHint: "Paste your Xiaomi MiMo pay-as-you-go API key from xiaomimimo.com.",
  strict: true,
  models: xiaomiPaygModels,
});
