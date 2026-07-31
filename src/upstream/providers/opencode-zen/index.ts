/**
 * OpenCode Zen — billed access to opencode.ai/zen/v1.
 * Same catalog and base URL as OpenCode Free; differs only in auth: Zen
 * requires a real, billed API key (higher rate limits and reliability).
 * @see https://opencode.ai/docs/zen/
 */

import { ProviderCallError } from "../index";
import { createOpenCodeProvider } from "../opencode-provider";
import { openCodeZenModelCatalog } from "./models";

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
