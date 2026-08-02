/**
 * OpenCode Free — free-tier access to opencode.ai/zen/v1.
 * No credential required: uses the shared public token "Bearer public".
 */

import { createOpenCodeProvider } from "./opencode-provider";
import { fetchOpenCodeCatalog } from "./opencode-catalog";
import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "./models";

const MODELS: ProviderModelEntry[] = [
  { id: "big-pickle", reasoning: true, vision: true, contextWindow: 272000, maxOutputTokens: 64000, description: "Big Pickle via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "deepseek-v4-flash-free", reasoning: true, contextWindow: 272000, maxOutputTokens: 64000, description: "DeepSeek V4 Flash Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "mimo-v2.5-free", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, description: "Mimo v2.5 Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "nemotron-3-ultra-free", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, description: "Nemotron 3 Ultra Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "north-mini-code-free", reasoning: true, contextWindow: 272000, maxOutputTokens: 64000, description: "North Mini Code Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "laguna-s-2.1-free", reasoning: true, contextWindow: 272000, maxOutputTokens: 64000, description: "Laguna S 2.1 Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
];

export const openCodeFreeModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);

export const openCodeFreeProvider = createOpenCodeProvider({
  id: "opencode-free",
  name: "OpenCode Free",
  icon: "opencode",
  authKind: "none",
  authHint: "This provider is ready to use. No credential required.",
  credentialKind: "none",
  models: openCodeFreeModelCatalog,
  authorizationHeader: () => "Bearer public",
});

export {
  type OpenCodeCapability,
  type OpenCodeModelEntry,
  findOpenCodeModel,
  selectCapability,
  resetOpenCodeCatalogForTests as resetOpenCodeFreeCatalogForTests,
} from "./opencode-catalog";

export { fetchOpenCodeCatalog as fetchOpenCodeFreeCatalog };
