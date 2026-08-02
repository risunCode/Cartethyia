/**
 * OpenCode Zen — billed access to opencode.ai/zen/v1.
 * Same catalog and base URL as OpenCode Free; differs only in auth: Zen
 * requires a real, billed API key (higher rate limits and reliability).
 * @see https://opencode.ai/docs/zen/
 */

import { ProviderCallError } from "./index";
import { createOpenCodeProvider } from "./opencode-provider";
import { fetchOpenCodeCatalog } from "./opencode-catalog";
import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "./models";

const MODELS: ProviderModelEntry[] = [
  { id: "big-pickle", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "Big Pickle via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "deepseek-v4-flash-free", reasoning: true, contextWindow: 256000, maxOutputTokens: 64000, description: "DeepSeek V4 Flash Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "mimo-v2.5-free", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, description: "Mimo v2.5 Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "ling-3.0-flash-free", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "Ling 3.0 Flash Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "nemotron-3-ultra-free", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, description: "Nemotron 3 Ultra Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "north-mini-code-free", reasoning: true, contextWindow: 256000, maxOutputTokens: 64000, description: "North Mini Code Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "laguna-s-2.1-free", reasoning: true, contextWindow: 256000, maxOutputTokens: 64000, description: "Laguna S 2.1 Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
];

export const openCodeZenModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);

export const openCodeZenProvider = createOpenCodeProvider({
  id: "opencode-zen",
  name: "OpenCode Zen",
  icon: "opencode",
  authKind: "api-key",
  authHint: "Paste your OpenCode Zen API key from opencode.ai (sign in, add billing, then copy the key).",
  credentialUrl: "https://opencode.ai/zen",
  credentialKind: "provider-bearer",
  models: openCodeZenModelCatalog,
  authorizationHeader: (value) => `Bearer ${value}`,
  validateCredential: (credential) => {
    if (!credential.value) {
      throw new ProviderCallError(401, "authentication", "OpenCode Zen requires an API key.");
    }
  },
});

export {
  type OpenCodeCapability,
  type OpenCodeModelEntry,
  findOpenCodeModel,
  selectCapability,
  resetOpenCodeCatalogForTests as resetOpenCodeZenCatalogForTests,
} from "./opencode-catalog";

export { fetchOpenCodeCatalog as fetchOpenCodeZenCatalog };
