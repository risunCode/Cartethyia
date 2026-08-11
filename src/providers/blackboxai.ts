import { capabilitiesOf, modelOf } from "../open-sse/transport/catalog";
import type { OpenAIAdapterConfig } from "../open-sse/transport/contracts";
import { createOpenAIAdapter } from "../open-sse/transport/openai-adapter";

const OPENAI_CHAT_SURFACES = ["openai-chat"] as const;

/**
 * Blackbox AI's upstream API expects the full `blackboxai/<vendor>/<model>` id
 * in the `model` field (verified against https://api.blackbox.ai/v1/models).
 * Our routing splits the client's `blackboxai/openai/gpt-5.4` into prefix
 * `blackboxai` + modelId `openai/gpt-5.4`, so catalog IDs are the stripped
 * form and `upstreamId` carries the full id transport sends upstream.
 */

export const blackboxaiConfig = {
  id: "blackboxai",
  displayName: "Blackbox AI",
  baseUrl: "https://api.blackbox.ai/v1",
  credentialKind: "api_key",
  models: [
    modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES, reasoning: true }), { upstreamId: "blackboxai/z-ai/glm-5.2" }),
    modelOf("z-ai/glm-5.2-vercel", "GLM 5.2 Vercel", capabilitiesOf({ surfaces: OPENAI_CHAT_SURFACES, reasoning: true }), { upstreamId: "blackboxai/z-ai/glm-5.2-vercel" }),
  ],
} as const satisfies OpenAIAdapterConfig;

export const BlackboxAIAdapter = createOpenAIAdapter(blackboxaiConfig);
