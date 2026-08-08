import { AbortCoordinator, ProviderAdapterError, capabilitiesOf, createModelCatalog, executeFetch, isRecord, lineLimit, mapSseStream, modelOf, readJsonObject, readUpstreamError, toProviderCallError } from "../open-sse/transport/shared";
import { callHostedImageWire, createResponsesMapper } from "../open-sse/transport/protocols/openai";
import { buildResponsesPayload, mapResponsesUsage } from "../open-sse/translate/codecs/openai-responses";
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
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";

/**
 * OpenAI Codex — the ChatGPT Codex backend
 * (https://chatgpt.com/backend-api/codex/responses) authenticated with an
 * OAuth access token whose JWT payload carries the ChatGPT account identity
 * (`chatgpt-account-id`). Speaks the OpenAI Responses wire format; the Codex
 * backend rejects sampling controls and output-token caps, so those are
 * stripped and the request is forced to stream. The account id is extracted
 * from the access-token JWT so no out-of-band account metadata is required.
 */

const CODEX_SURFACES: readonly Surface[] = ["openai-chat", "images"];
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_VERSION = "0.144.1";
const CODEX_ORIGINATOR = "pi";
const CODEX_AUTH_PATH = "https://api.openai.com/auth";

const CODEX_MODELS: readonly ProviderModel[] = [
  modelOf("gpt-5.6-sol", "GPT 5.6 Sol", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.6-terra", "GPT 5.6 Terra", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.6-luna", "GPT 5.6 Luna", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.5", "GPT 5.5", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.4", "GPT 5.4", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.4-mini", "GPT 5.4 Mini", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true })),
  modelOf("gpt-5.5-image", "GPT 5.5 Image", capabilitiesOf({ surfaces: ["images"], images: true })),
  modelOf("gpt-5.4-image", "GPT 5.4 Image", capabilitiesOf({ surfaces: ["images"], images: true })),
  modelOf("gpt-5.3-image", "GPT 5.3 Image", capabilitiesOf({ surfaces: ["images"], images: true })),
];

const CODEX_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: CODEX_SURFACES, reasoning: true, images: true });

function base64Decode(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Decodes the Codex access-token JWT to extract the ChatGPT account id. */
function codexAccountId(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64Decode(parts[1] ?? "")) as Record<string, unknown>;
    const auth = payload[CODEX_AUTH_PATH];
    if (isRecord(auth)) {
      const id = nonEmpty(auth.chatgpt_account_id);
      if (id) return id;
    }
    return nonEmpty(payload.account_id) ?? null;
  } catch {
    return null;
  }
}

/** Codex is the OAuth-gated ChatGPT Codex Responses transport. */
export class CodexAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "codex",
    displayName: "Codex ChatGPT",
    protocol: "openai",
    credentialKind: "oauth",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(CODEX_MODELS);
  readonly capabilities: ProviderCaps = { ...CODEX_FALLBACK_CAPABILITIES, streaming: true };

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
    if (input.target.surface !== "openai-chat" && input.target.surface !== "images") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${input.target.surface}"`, statusCode: 400, routeScope: null });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Codex OAuth access token is required.", statusCode: 401, routeScope: "account" });
    }
    const accountId = codexAccountId(input.credential);
    if (accountId === null) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "Codex OAuth credential is missing its ChatGPT account identity.", statusCode: 401, routeScope: "account" });
    }
    if (input.target.surface === "images") {
      return callHostedImageWire(input, `${CODEX_BASE_URL}/codex/responses`, {
        "content-type": "application/json",
        authorization: `Bearer ${input.credential}`,
        "chatgpt-account-id": accountId,
        "openai-beta": "responses=experimental",
        originator: CODEX_ORIGINATOR,
        version: CODEX_VERSION,
        "user-agent": `codex-cli/${CODEX_VERSION}`,
      });
    }
    const { request, signal, network } = input;
    // Codex rejects sampling controls and output-token caps with 400; the
    // native client lets the Codex backend choose these values.
    const payload = buildResponsesPayload(request);
    delete payload.temperature;
    delete payload.top_p;
    delete payload.max_output_tokens;
    delete payload.max_completion_tokens;
    payload.store = false;
    payload.stream = true;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${input.credential}`,
      "chatgpt-account-id": accountId,
      "openai-beta": "responses=experimental",
      originator: CODEX_ORIGINATOR,
      version: CODEX_VERSION,
      "user-agent": `codex-cli/${CODEX_VERSION}`,
    };
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${CODEX_BASE_URL}/codex/responses`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) throw await readUpstreamError(response);
      if (!request.stream) {
        const body = await readJsonObject(response, coordinator);
        const usageRecord = isRecord(body.usage) ? body.usage : null;
        return { mode: "non_stream", body, usage: usageRecord !== null ? mapResponsesUsage(usageRecord) : undefined };
      }
      if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Codex returned an empty stream body", routeScope: "provider" });
      streamHandedOff = true;
      return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, createResponsesMapper()) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

