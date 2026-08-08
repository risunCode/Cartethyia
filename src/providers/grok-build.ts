import { AbortCoordinator,
ProviderAdapterError,
capabilitiesOf,
createModelCatalog,
decodeSseEvents,
executeFetch,
lineLimit,
mapSseStream,
modelOf,
parseSseData,
readUpstreamError,
toProviderCallError, } from "../open-sse/transport/shared";
import { isRecord } from "../application/protocols";
import { createResponsesMapper } from "../open-sse/transport/protocols/openai";
import { buildResponsesPayload, mapResponsesUsage } from "../open-sse/translate/codecs/openai-responses";
import type {
  Adapter,
  ProviderCaps,
  ProviderMeta,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  Surface,
  RouteTarget,
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";

/**
 * Grok Build — the Grok subscription backend at cli-chat-proxy.grok.com.
 *
 * Authenticated with an OAuth device-code access token (xai-grok-cli). Speaks
 * the OpenAI Responses wire format; the backend forces `store=false` and
 * `stream=true`. System role is preserved (not converted to `developer` like
 * Codex). Reasoning effort is only accepted by `grok-4.5*` models.
 *
 * Source of truth: wire capture of official @xai-official/grok 0.2.99.
 * User-Agent follows the official client — never a Cartethyia identity.
 */

const GROK_BUILD_SURFACES: readonly Surface[] = ["openai-responses"];
const GROK_BUILD_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const GROK_BUILD_VERSION = "0.2.120";
const GROK_BUILD_USER_AGENT = `grok-shell/${GROK_BUILD_VERSION} (linux; x86_64)`;
const GROK_BUILD_CLIENT_IDENTIFIER = "grok-shell";

const GROK_BUILD_MODELS: readonly ProviderModel[] = [
  modelOf("grok-4.6", "Grok 4.6", capabilitiesOf({ surfaces: GROK_BUILD_SURFACES, reasoning: true }), { context: { inputTokens: 500000, outputTokens: 64000 } }),
  modelOf("grok-4.5", "Grok 4.5", capabilitiesOf({ surfaces: GROK_BUILD_SURFACES, reasoning: true }), { context: { inputTokens: 500000, outputTokens: 64000 } }),
];

const GROK_BUILD_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: GROK_BUILD_SURFACES, reasoning: true });

function normalizeEffort(value: string | undefined | null): string {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (effort === "max") return "xhigh";
  if (["low", "medium", "high", "xhigh"].includes(effort)) return effort;
  return "high";
}
export class GrokBuildAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "grok-build",
    displayName: "Grok Build",
    protocol: "openai",
    credentialKind: "oauth",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(GROK_BUILD_MODELS);
  readonly capabilities: ProviderCaps = { ...GROK_BUILD_FALLBACK_CAPABILITIES, streaming: true };

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
    if (input.target.surface !== "openai-responses") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${input.target.surface}"`, statusCode: 400, routeScope: null });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Grok Build OAuth access token is required.", statusCode: 401, routeScope: "account" });
    }
    const { request, signal, network } = input;
    const payload = buildResponsesPayload(request);
    // Grok Build backend forces store=false and stream=true (like Codex).
    payload.store = false;
    payload.stream = true;
    // System role is preserved (not converted to developer like Codex).
    // Strip sampling controls that the Grok Build backend rejects.
    delete payload.temperature;
    delete payload.top_p;
    delete payload.max_output_tokens;
    delete payload.max_completion_tokens;
    // Resolve upstream model — use the routing-resolved bare model ID (no provider prefix).
    const resolvedModel = input.target.upstreamModelId;
    payload.model = resolvedModel;
    // Reasoning: always set summary=concise; effort comes from the request's
    // reasoning level (adaptive — the client picks low/medium/high/xhigh).
    let reasoning: Record<string, unknown>;
    const existing = payload.reasoning;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      reasoning = { summary: "concise" };
    } else {
      reasoning = { ...existing };
    }
    reasoning.effort = normalizeEffort(typeof reasoning.effort === "string" ? reasoning.effort : "high");
    if (!reasoning.summary) reasoning.summary = "concise";
    payload.reasoning = reasoning;
    // Request encrypted reasoning content for multi-turn continuity.
    if (reasoning.effort !== "none") {
      const include = Array.isArray(payload.include) ? payload.include : [];
      if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
      payload.include = include;
    }
    // Drop Chat Completions leftovers that Responses rejects.
    delete (payload as Record<string, unknown>).messages;
    delete (payload as Record<string, unknown>).max_tokens;
    delete (payload as Record<string, unknown>).n;
    delete (payload as Record<string, unknown>).seed;
    delete (payload as Record<string, unknown>).logprobs;
    delete (payload as Record<string, unknown>).top_logprobs;
    delete (payload as Record<string, unknown>).frequency_penalty;
    delete (payload as Record<string, unknown>).presence_penalty;
    delete (payload as Record<string, unknown>).user;
    delete (payload as Record<string, unknown>).stream_options;
    delete (payload as Record<string, unknown>).previous_response_id;

    // Session/request IDs for Grok headers — stable per request.
    const sessionId = crypto.randomUUID();
    const reqId = crypto.randomUUID();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${input.credential}`,
      "user-agent": GROK_BUILD_USER_AGENT,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-identifier": GROK_BUILD_CLIENT_IDENTIFIER,
      "x-grok-client-version": GROK_BUILD_VERSION,
      "x-grok-client-mode": "headless",
      "x-grok-session-id": sessionId,
      "x-grok-conv-id": sessionId,
      "x-grok-req-id": reqId,
      "x-grok-turn-idx": "1",
      "x-grok-model-override": resolvedModel,
    };

    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${GROK_BUILD_BASE_URL}/responses`, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) throw await readUpstreamError(response);
      if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Grok Build returned an empty stream body", routeScope: "provider" });
      // Grok Build forces stream=true upstream. When the client requested
      // non-stream, decode the SSE events raw and extract the final
      // `response.completed` payload as the JSON response body.
      if (!request.stream) {
        let finalBody: Record<string, unknown> = {};
        let usageRecord: Record<string, unknown> | null = null;
        let completed = false;
        for await (const sse of decodeSseEvents({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs })) {
          const parsed = parseSseData(sse.data);
          if (!isRecord(parsed)) continue;
          const type = typeof parsed.type === "string" ? parsed.type : "";
          if (type === "response.completed") {
            const response = parsed.response;
            if (isRecord(response)) {
              finalBody = response;
              completed = true;
              if (isRecord(response.usage)) usageRecord = response.usage;
            }
          }
        }
        if (!completed) {
          throw new ProviderAdapterError({ kind: "stream_truncated", message: "Grok Build stream ended without a response.completed event", retryable: true, routeScope: "provider" });
        }
        return { mode: "non_stream", body: finalBody, usage: usageRecord !== null ? mapResponsesUsage(usageRecord) : undefined };
      }
      streamHandedOff = true;
      return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, createResponsesMapper()) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}
