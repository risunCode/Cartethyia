import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";

export const CURSOR_PROVIDER_ID = "cursor" as const;
export const CURSOR_BASE_URL = providerBaseUrl(CURSOR_PROVIDER_ID);
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run" as const;

function cursorModel(modelId: string, reasoning: boolean): ModelDefinition {
  return defineModel({
    id: modelId,
    wireFamily: "native",
    endpoint: CURSOR_RUN_PATH,
    ctx: 200_000,
    out: 64_000,
    vision: true,
    reasoning,
    toolCall: false,
    webSearch: true,
  });
}

/** Static fallback catalog; live discovery runs through GetUsableModels. */
export const CURSOR_MODELS: readonly ModelDefinition[] = [
  cursorModel("default", false),
  cursorModel("claude-4.5-opus-high", true),
  cursorModel("claude-4.5-sonnet", true),
  cursorModel("claude-4.6-opus-high", true),
  cursorModel("claude-4.6-sonnet-medium", true),
  cursorModel("composer-2.5", false),
  cursorModel("composer-2.5-fast", false),
];
