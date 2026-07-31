/**
 * OpenCode Free — free-tier access to opencode.ai/zen/v1.
 * No credential required: uses the shared public token "Bearer public".
 * Operators can route through a proxy pool to bypass per-IP rate limits.
 */

import { createOpenCodeProvider } from "../opencode-provider";
import { openCodeFreeModelCatalog } from "./models";

export const openCodeFreeProvider = createOpenCodeProvider({
  id: "opencode-free",
  name: "OpenCode Free",
  icon: "opencode",
  authKind: "none",
  authHint:
    "This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.",
  credentialKind: "none",
  models: openCodeFreeModelCatalog,
  authorizationHeader: () => "Bearer public",
});
