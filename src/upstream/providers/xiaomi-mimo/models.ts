import { createModelCatalog, type ProviderModelCatalog } from "../models";

/**
 * Pay-as-you-go tier (`xiaomi-mimo`, distinct from Token Plan) — matches
 * 9router's registry. Curated down to mimo-v2.5-pro and mimo-v2.5 per
 * operator preference.
 */
export const xiaomiMimoModelCatalog: ProviderModelCatalog = createModelCatalog([
  { id: "mimo-v2.5-pro", capabilities: ["text", "streaming", "json", "tools"], contextWindow: 1000000, maxOutputTokens: 128000 },
  { id: "mimo-v2.5", capabilities: ["text", "streaming", "json", "tools"], contextWindow: 1000000, maxOutputTokens: 128000 },
]);
