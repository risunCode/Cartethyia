import { aggregateCapabilities, capabilitiesOf, createModelCatalog, modelOf, toProviderCallError } from "./shared";
import type { ContextStats, Adapter, ProviderCaps, ProviderMeta, ProviderModel, ProviderModelCatalog, ProviderOutput, ProviderRequest, Surface, RouteTarget, TokenCountInput } from "../domain/contracts";
import { callChatCompletionsWire } from "../transport/protocols/openai";
import { ProviderAdapterError } from "./shared";

const SURFACES: readonly Surface[] = ["openai-chat"];
const GLOBAL_BASE_URL = "https://www.codebuddy.ai/v2";
const CHINA_BASE_URL = "https://www.codebuddy.cn/v2";

/** Maps a client-facing model id to the upstream id CodeBuddy's API expects. */
function upstreamIdFor(id: string, providerId: string): string {
  const clean = id.replace(/-thinking$/, "");
  if (providerId === "codebuddy") {
    if (/^(opus|sonnet|haiku)-/.test(clean)) return `claude-${clean}`;
    if (clean === "deepseek-v3-2") return "deepseek-v3-2-volc";
    if (clean === "enowx") return "enowx-default";
  }
  return clean;
}

const globalModels: readonly ProviderModel[] = [
  ["opus-4.8", "Claude Opus 4.8", true, true, 1_000_000, 64_000], ["opus-4.8-1m", "Claude Opus 4.8 1M", true, true, 1_000_000, 64_000], ["opus-4.7", "Claude Opus 4.7", true, true, 1_000_000, 64_000], ["opus-4.7-1m", "Claude Opus 4.7 1M", true, true, 1_000_000, 64_000], ["opus-4.6", "Claude Opus 4.6", true, true, 1_000_000, 64_000], ["sonnet-4.6", "Claude Sonnet 4.6", true, true, 200_000, 64_000], ["haiku-4.5", "Claude Haiku 4.5", true, true, 200_000, 8_192],
  ["gpt-5.1", "GPT-5.1", true, true, null, null], ["gpt-5.1-codex", "GPT-5.1 Codex", true, true, null, null], ["gpt-5.1-codex-max", "GPT-5.1 Codex Max", true, true, null, null], ["gpt-5.1-codex-mini", "GPT-5.1 Codex Mini", true, true, null, null], ["gpt-5.2", "GPT-5.2", true, true, null, null], ["gpt-5.2-codex", "GPT-5.2 Codex", true, true, null, null], ["gpt-5.3-codex", "GPT-5.3 Codex", true, true, null, null], ["gpt-5.4", "GPT-5.4", true, true, null, null], ["gpt-5.5", "GPT-5.5", true, true, null, null], ["gpt-5.5-xhigh", "GPT-5.5 xhigh", true, true, null, null],
  ["gemini-2.5-flash", "Gemini 2.5 Flash", true, true, null, null], ["gemini-2.5-pro", "Gemini 2.5 Pro", true, true, null, null], ["gemini-3.0-flash", "Gemini 3 Flash", false, true, null, null], ["gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", false, true, null, null], ["gemini-3.1-pro", "Gemini 3.1 Pro", false, true, null, null], ["gemini-3.5-flash", "Gemini 3.5 Flash", true, true, null, null], ["deepseek-v3-2", "DeepSeek V3.2", false, false, null, null], ["kimi-k2.5", "Kimi K2.5", false, false, null, null], ["enowx", "Enowx", false, true, null, null],
].map(([id, name, reasoning, vision, contextWindow, maxOutputTokens]) => modelOf(id as string, name as string, capabilitiesOf({ surfaces: SURFACES, reasoning: reasoning as boolean, images: vision as boolean }), { upstreamId: upstreamIdFor(id as string, "codebuddy"), context: { inputTokens: contextWindow as number | null, outputTokens: maxOutputTokens as number | null } }));

const chinaModels: readonly ProviderModel[] = [
  ["glm-5.2", "GLM 5.2", false, true, 1_000_000, 8_192], ["glm-5.1", "GLM 5.1", false, true, 200_000, 8_192], ["glm-5.0", "GLM 5.0", false, true, 200_000, 8_192], ["glm-5.0-turbo", "GLM 5.0 Turbo", false, true, 200_000, 8_192], ["glm-5v-turbo", "GLM 5v Turbo", false, true, 200_000, 8_192], ["glm-4.7", "GLM 4.7", false, true, 200_000, 8_192], ["minimax-m3", "MiniMax M3", false, true, 512_000, 8_192], ["minimax-m2.7", "MiniMax M2.7", false, true, 512_000, 8_192], ["kimi-k2.7", "Kimi K2.7", true, true, 256_000, 8_192], ["kimi-k2.6", "Kimi K2.6", false, true, 256_000, 8_192], ["kimi-k2.5", "Kimi K2.5", false, true, 164_000, 8_192], ["hy3-preview", "Hunyuan Hy3 Preview", false, false, 192_000, 8_192], ["deepseek-v4-pro", "DeepSeek V4 Pro", false, true, 1_000_000, 8_192],
].map(([id, name, reasoning, vision, contextWindow, maxOutputTokens]) => modelOf(id as string, name as string, capabilitiesOf({ surfaces: SURFACES, reasoning: reasoning as boolean, images: vision as boolean }), { upstreamId: upstreamIdFor(id as string, "codebuddy-cn"), context: { inputTokens: contextWindow as number | null, outputTokens: maxOutputTokens as number | null } }));

function headers(credential: string, domain: string, incoming?: Headers): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream, application/json", authorization: `Bearer ${credential}`, "x-product": "SaaS", "x-domain": domain, "x-requested-with": "XMLHttpRequest", "x-conversation-id": crypto.randomUUID(), "x-request-id": crypto.randomUUID().replace(/-/g, "") };
  const clientName = incoming?.get("x-client-name"); if (clientName) result["x-client-name"] = clientName;
  return result;
}

abstract class CodeBuddyBaseAdapter implements Adapter {
  abstract readonly metadata: ProviderMeta;
  abstract readonly models: ProviderModelCatalog;
  abstract readonly baseUrl: string;
  abstract readonly modelPrefix: string;
  readonly capabilities: ProviderCaps;
  constructor(models: readonly ProviderModel[]) { this.capabilities = aggregateCapabilities(models, capabilitiesOf({ surfaces: SURFACES, streaming: true, reasoning: true, images: true, toolCalls: true })); }
  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `${this.metadata.displayName} supports OpenAI Chat only.`, statusCode: 400, routeScope: null });
    if (this.models.get(modelId) === null) throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the ${this.metadata.displayName} catalog.`, statusCode: 404, routeScope: "provider" });
    const entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: entry?.upstreamId ?? modelId, surface };
  }
  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (!input.credential) throw new ProviderAdapterError({ kind: "authentication_failed", message: `${this.metadata.displayName} requires an API key.`, statusCode: 401, routeScope: "account" });
    return callChatCompletionsWire(input, this.baseUrl, headers(input.credential, this.metadata.id === "codebuddy" ? "www.codebuddy.ai" : "www.codebuddy.cn", input.headers));
  }
  countTokens(_input: TokenCountInput): Promise<ContextStats> { return Promise.resolve({ tokens: null, source: "unknown" }); }
  mapError(error: unknown) { return toProviderCallError(error); }
}

export class CodeBuddyAdapter extends CodeBuddyBaseAdapter {
  readonly metadata: ProviderMeta = { id: "codebuddy", displayName: "CodeBuddy", protocol: "openai", credentialKind: "api_key" };
  readonly models = createModelCatalog(globalModels);
  readonly baseUrl = GLOBAL_BASE_URL;
  readonly modelPrefix = "";
  constructor() { super(globalModels); }
}

export class CodeBuddyChinaAdapter extends CodeBuddyBaseAdapter {
  readonly metadata: ProviderMeta = { id: "codebuddy-cn", displayName: "CodeBuddy CN", protocol: "openai", credentialKind: "api_key" };
  readonly models = createModelCatalog(chinaModels);
  readonly baseUrl = CHINA_BASE_URL;
  readonly modelPrefix = "";
  constructor() { super(chinaModels); }
}
