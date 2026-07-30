import { createOpenAICompatibleProvider } from "../openai-compatible";
import { opencodeGoModels } from "./models";

export const opencodeGoProvider = createOpenAICompatibleProvider({
  id: "opencode-go",
  name: "OpenCode Go",
  icon: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  credentialUrl: "https://opencode.ai/auth",
  models: opencodeGoModels,
});
