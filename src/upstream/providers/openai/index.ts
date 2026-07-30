import { createOpenAICompatibleProvider } from "../openai-compatible";
import { openaiModels } from "./models";

export const openaiProvider = createOpenAICompatibleProvider({
  id: "openai",
  name: "OpenAI",
  icon: "openai",
  baseUrl: "https://api.openai.com/v1",
  credentialUrl: "https://platform.openai.com/api-keys",
  authHint: "Paste your official OpenAI API key (starts with sk-...) from platform.openai.com.",
  models: openaiModels,
});
