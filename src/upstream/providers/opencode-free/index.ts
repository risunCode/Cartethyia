/**
 * OpenCode Free — free-tier access to opencode.ai/zen/v1.
 * No credential required: uses the shared public token "Bearer public".
 */

import { createOpenCodeProvider } from "../opencode-provider";
import { openCodeFreeModelCatalog } from "./models";

export const openCodeFreeProvider = createOpenCodeProvider({
  id: "opencode-free",
  name: "OpenCode Free",
  icon: "opencode",
  authKind: "none",
  authHint:
    "This provider is ready to use. No credential required.",
  credentialKind: "none",
  models: openCodeFreeModelCatalog,
  authorizationHeader: () => "Bearer public",
});
