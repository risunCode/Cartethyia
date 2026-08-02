import type { RouteTarget } from "../../routing/types";
import { translateChatRequestToGemini, type GeminiRequest } from "../../translate/google-gemini";
import type { OpenAIChatRequest } from "../../translate/types";
import { buildProxyFetcher } from "../proxy/adapter";
import type { ProxyTarget } from "../proxy/types";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./types";
import type { ProviderModelCatalog, ProviderModelEntry } from "./models";
import { ProviderCallError } from "./errors";
import { callSimpleProvider } from "./simple-call";
import { decodeGoogleGeminiStream } from "./google-gemini-handler";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_MODELS: ProviderModelEntry[] = [
  { id: "gemini-3.1-pro", reasoning: true, vision: true, websearch: true, contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: "gemini-pro-agent", reasoning: true, vision: true, websearch: true, contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: "gemini-3.1-pro-preview", reasoning: true, vision: true, websearch: true, contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: "gemini-3.5-flash", reasoning: true, vision: true, websearch: true, contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: "gemini-3-flash", reasoning: true, vision: true, websearch: true, contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  { id: "claude-sonnet-4-6", reasoning: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  { id: "claude-opus-4-6", reasoning: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  { id: "claude-opus-4-6-thinking", reasoning: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  { id: "gpt-oss-120b", reasoning: true, contextWindow: 131_072, maxOutputTokens: 32_768 },
];
const antigravityKnown = new Map(ANTIGRAVITY_MODELS.map((model) => [model.id, model]));
const antigravityModels: ProviderModelCatalog = {
  list: () => [...ANTIGRAVITY_MODELS],
  resolve: (modelId) => antigravityKnown.get(modelId) ?? (modelId.trim() ? { id: modelId, reasoning: true } : undefined),
};

function wantsWebSearch(request: OpenAIChatRequest): boolean {
  if (request.web_search_options !== undefined) return true;
  return request.tools?.some((tool) => tool.type === "web_search" || tool.type === "web_search_preview") ?? false;
}

interface AntigravityWireProfile {
  modelEnum?: string;
  maxOutputTokens: number;
}

const ANTIGRAVITY_WIRE_PROFILES: Record<string, AntigravityWireProfile> = {
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65_536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65_536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65_536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65_535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65_535 },
  "claude-sonnet-4-6": { maxOutputTokens: 64_000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64_000 },
};

function antigravityWireModelId(modelId: string): string {
  if (modelId === "gemini-3.1-pro" || modelId === "gemini-3.1-pro-low") return "gemini-3.1-pro-low";
  if (modelId === "gemini-3.1-pro-high") return "gemini-pro-agent";
  if (modelId === "gemini-3.5-flash") return "gemini-3.5-flash-extra-low";
  if (modelId === "gemini-3.5-flash-medium") return "gemini-3.5-flash-low";
  if (modelId === "gemini-3.5-flash-high") return "gemini-3-flash-agent";
  return modelId;
}

function thinkingBudget(modelId: string): number | undefined {
  if (!modelId.includes("claude") && !modelId.includes("gemini-3")) return undefined;
  if (modelId.endsWith("-low")) return 1_000;
  if (modelId.endsWith("-medium")) return 4_000;
  if (modelId.endsWith("-high")) return 10_000;
  return modelId.includes("3.1-pro") ? 10_001 : 10_000;
}

/** Builds the latest oh-my-pi-compatible Antigravity Cloud Code envelope. */
export function buildAntigravityRequest(target: RouteTarget, request: OpenAIChatRequest, credential: ResolvedCredential): GeminiRequest {
  const projectId = credential.providerMetadata?.projectId;
  if (!projectId) throw new ProviderCallError(401, "authentication", "Antigravity OAuth credential is missing its Cloud Code project id.");
  const trajectoryId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const step = 2;
  const wireModelId = antigravityWireModelId(target.modelId);
  const wireProfile = ANTIGRAVITY_WIRE_PROFILES[wireModelId];
  const labels: Record<string, string> = { trajectory_id: trajectoryId, last_step_index: String(step - 1), used_claude: String(target.modelId.includes("claude")), used_claude_conservative: String(target.modelId.includes("claude")) };
  if (wireProfile?.modelEnum) labels.model_enum = wireProfile.modelEnum;
  const outbound = translateChatRequestToGemini(request, {
    project: projectId,
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    model: wireModelId,
    labels,
    sessionId: credential.accountId ?? trajectoryId,
  });
  const generationConfig: Record<string, unknown> = {};
  if (typeof request.max_tokens === "number") generationConfig.maxOutputTokens = request.max_tokens;
  if (wireProfile) generationConfig.maxOutputTokens = wireProfile.maxOutputTokens;
  if (typeof request.temperature === "number") generationConfig.temperature = request.temperature;
  if (typeof request.top_p === "number") generationConfig.topP = request.top_p;
  const budget = thinkingBudget(wireModelId);
  if (budget !== undefined) generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
  if (Object.keys(generationConfig).length > 0) outbound.request.generationConfig = generationConfig;
  if (wantsWebSearch(request)) {
    outbound.request.tools = [...(outbound.request.tools ?? []), { googleSearch: {} }];
  }
  if (target.modelId.includes("claude") && !outbound.request.toolConfig) outbound.request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  return outbound;
}

class GoogleAntigravityProvider implements Provider {
  readonly id = "google-antigravity" as const;
  readonly display = { name: "Antigravity", icon: "antigravity", authKind: "oauth" as const, authHint: "Connect Antigravity with Google OAuth and Cloud Code Assist project provisioning.", credentialUrl: "https://accounts.google.com/" };
  readonly models = antigravityModels;

  resolveTarget(modelId: string): RouteTarget | undefined {
    if (!this.models.resolve(modelId)) return undefined;
    return { provider: this.id, modelId, surface: "openai-chat", credential: "oauth", weight: 1 };
  }

  async call(target: RouteTarget, request: ProviderRequest, credential: ResolvedCredential, signal: AbortSignal, proxy?: ProxyTarget | null): Promise<ProviderResult> {
    if (request.surface !== "openai-chat") throw new ProviderCallError(400, "invalid_request", "Antigravity currently accepts the OpenAI Chat shape.");
    if (credential.kind !== "oauth" || !credential.value) throw new ProviderCallError(401, "authentication", "Antigravity requires a Google OAuth credential.");
    const body = buildAntigravityRequest(target, request.body as OpenAIChatRequest, credential);
    const headers = { authorization: `Bearer ${credential.value}`, "content-type": "application/json", accept: "text/event-stream", "user-agent": "antigravity/hub/2.1.4" };
    const options = { headers, body, signal, providerLabel: "Antigravity", isStreaming: true, decodeStream: decodeGoogleGeminiStream, fetcher: proxy ? buildProxyFetcher(proxy) : undefined };
    try {
      return await callSimpleProvider({ url: `${ANTIGRAVITY_DAILY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, ...options });
    } catch (error) {
      if (error instanceof ProviderCallError && (error.status === 429 || error.status >= 500)) return callSimpleProvider({ url: `${ANTIGRAVITY_SANDBOX_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, ...options });
      throw error;
    }
  }
}

export const googleAntigravityProvider = new GoogleAntigravityProvider();
