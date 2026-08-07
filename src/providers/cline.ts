import { AbortCoordinator, ProviderAdapterError, capabilitiesOf, createModelCatalog, executeFetch, isRecord, lineLimit, mapSseStream, modelOf, readJsonObject, readUpstreamError, toProviderCallError } from "./shared";
import { createChatMapper } from "../transport/protocols/openai";
import { buildChatPayload } from "../domain/protocols/openai-chat";
import type {
  ContextStats,
  Adapter,
  ProviderCaps,
  ProviderMeta,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  Surface,
  RouteTarget,
  TokenCountInput,
} from "../domain/contracts";
import type { ProviderCallError } from "../domain/contracts";

/**
 * Cline — an OpenAI-compatible Chat Completions gateway
 * (https://api.cline.bot/api/v1) gated on a WorkOS-wrapped OAuth bearer token.
 * Same wire format as the OpenAI adapter; the Cline-specific bits are the
 * `workos:` credential prefix, the fixed Cline CLI client-identity headers, and
 * its curated model catalog. Retries once on the legacy "empty response content"
 * 500 that the Cline gateway intermittently returns.
 */

const CLINE_SURFACES: readonly Surface[] = ["openai-chat"];
const CLINE_BASE_URL = "https://api.cline.bot/api/v1";
const CLINE_CHAT_URL = `${CLINE_BASE_URL}/chat/completions`;
const CLINE_CLIENT_VERSION = "4.0.11";

const CLINE_MODELS: readonly ProviderModel[] = [
  modelOf("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-sol-pro", "GPT 5.6 Sol Pro", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-sol", "GPT 5.6 Sol", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-terra-pro", "GPT 5.6 Terra Pro", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-terra", "GPT 5.6 Terra", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-luna-pro", "GPT 5.6 Luna Pro", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("openai/gpt-5.6-luna", "GPT 5.6 Luna", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("minimax/minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("google/gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite", capabilitiesOf({ surfaces: CLINE_SURFACES })),
  modelOf("kwaipilot/kat-coder-pro-v2", "Kat Coder Pro V2", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
];

const CLINE_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true });
const CLINEPASS_MODELS: readonly ProviderModel[] = [
  modelOf("cline-pass/glm-5.2", "GLM 5.2 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("cline-pass/kimi-k2.7-code", "Kimi K2.7 Code (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("cline-pass/kimi-k2.6", "Kimi K2.6 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true, images: true })),
  modelOf("cline-pass/deepseek-v4-pro", "DeepSeek V4 Pro (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/deepseek-v4-flash", "DeepSeek V4 Flash (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/mimo-v2.5", "MiMo V2.5 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/mimo-v2.5-pro", "MiMo V2.5 Pro (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/minimax-m3", "MiniMax M3 (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/qwen3.7-max", "Qwen 3.7 Max (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
  modelOf("cline-pass/qwen3.7-plus", "Qwen 3.7 Plus (ClinePass)", capabilitiesOf({ surfaces: CLINE_SURFACES, reasoning: true })),
];

function clineHeaders(bearer: string, stream: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${bearer}`,
    "http-referer": "https://cline.bot",
    "x-title": "Cline",
    "x-platform": "server",
    "x-platform-version": "1.0.0",
    "x-client-type": "cline-cli",
    "x-client-version": CLINE_CLIENT_VERSION,
    "x-core-version": CLINE_CLIENT_VERSION,
    "x-is-multi-root": "false",
    "user-agent": `Cline/${CLINE_CLIENT_VERSION}`,
  };
}

/** Extracts the bearer access token from a stored credential (bundle JSON or raw token). */
function accessTokenFromCredential(credential: string): string | undefined {
  const trimmed = credential.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).accessToken === "string") {
        const access = (parsed as Record<string, unknown>).accessToken as string;
        return access.length > 0 ? access : undefined;
      }
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

/** Cline wraps a bare access token in the `workos:` prefix its gateway expects. */
function clineBearer(credential: string): string {
  return credential.startsWith("workos:") ? credential : `workos:${credential}`;
}

/** Cline requires a system/developer message; inject a minimal default when absent. */
function ensureSystemMessage(messages: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  if (messages.some((message) => message.role === "system" || message.role === "developer")) return messages;
  return [{ role: "system", content: "" }, ...messages];
}

async function callClineOnce(input: ProviderRequest, bearer: string): Promise<ProviderOutput> {
  const { request, signal, network } = input;
  const encoded = buildChatPayload({ ...request, model: input.target.upstreamModelId });
  const wireMessages = Array.isArray(encoded.messages) ? encoded.messages.filter(isRecord) : [];
  const payload: Record<string, unknown> = {
    ...encoded,
    messages: ensureSystemMessage(wireMessages),
  };
  const coordinator = new AbortCoordinator(signal, {
    connectTimeoutMs: request.limits.connectTimeoutMs,
    totalTimeoutMs: request.limits.totalTimeoutMs,
  });
  let streamHandedOff = false;
  try {
    const response = await executeFetch(CLINE_CHAT_URL, { method: "POST", headers: clineHeaders(bearer, request.stream), body: JSON.stringify(payload) }, coordinator, network);
    if (!response.ok) throw await readUpstreamError(response);
    if (!request.stream) {
      const body = await readJsonObject(response, coordinator);
      const data = isRecord(body.data) ? body.data : body;
      return { mode: "non_stream", body: data };
    }
    if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Cline returned an empty stream body", routeScope: "provider" });
    streamHandedOff = true;
    const events = mapSseStream(
      { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
      createChatMapper(),
    );
    return { mode: "stream", events };
  } finally {
    if (!streamHandedOff) coordinator.dispose();
  }
}

/** Cline is an OAuth/session gateway speaking the OpenAI Chat Completions wire format. */
export class ClineAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "cline",
    displayName: "Cline",
    protocol: "openai",
    credentialKind: "oauth",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(CLINE_MODELS);
  readonly capabilities: ProviderCaps = { ...CLINE_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    if (this.models.get(modelId) === null) {
      throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`, statusCode: 404, routeScope: "provider" });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.surface !== "openai-chat") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    }
    const token = accessTokenFromCredential(input.credential);
    if (token === undefined) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Cline OAuth credential is required.", statusCode: 401, routeScope: "account" });
    }
    const bearer = clineBearer(token);
    try {
      return await callClineOnce(input, bearer);
    } catch (error) {
      if (error instanceof ProviderAdapterError && error.statusCode === 500 && /empty response content/i.test(error.message)) {
        return callClineOnce(input, bearer);
      }
      throw error;
    }
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

/** ClinePass supports plain API keys and the same WorkOS OAuth bundles. */
export class ClinePassAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "clinepass",
    displayName: "ClinePass",
    protocol: "openai",
    credentialKind: "oauth",
    credentialKinds: ["oauth", "api_key"],
  };
  readonly models: ProviderModelCatalog = createModelCatalog(CLINEPASS_MODELS);
  readonly capabilities: ProviderCaps = { ...CLINE_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    if (this.models.get(modelId) === null) throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`, statusCode: 404, routeScope: "provider" });
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "openai-chat") throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only supports the OpenAI Chat surface`, statusCode: 400, routeScope: null });
    const token = accessTokenFromCredential(input.credential);
    if (token === undefined) throw new ProviderAdapterError({ kind: "authentication_failed", message: "A ClinePass API key or OAuth credential is required.", statusCode: 401, routeScope: "account" });
    // Plain API keys are sent as-is; only OAuth bundles get the workos: prefix.
    const bearer = input.credential.trim().startsWith("{") ? clineBearer(token) : token;
    return callClineOnce(input, bearer);
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

export const clinePassModelCatalog = CLINEPASS_MODELS;

