import { AbortCoordinator } from "../open-sse/transport/abort-coordinator";
import { ProviderAdapterError, readUpstreamError, toProviderCallError } from "../open-sse/transport/errors";
import { capabilitiesOf, createModelCatalog, modelOf } from "../open-sse/transport/catalog";
import { executeFetch } from "../open-sse/transport/fetch";
import { resolveModelCapabilities } from "../open-sse/translate/capabilities";
import { classifyCompatibilityRejection, recordCompatibilityFallback, removeCompatibilityProjection } from "../open-sse/translate/fallback";
import { lineLimit } from "../open-sse/transport/sse-decoder";
import { mapSseStream } from "../open-sse/transport/stream-mapper";
import { readJsonObject } from "../open-sse/transport/body-reader";
import { isRecord } from "../application/protocols";
import { createAnthropicMessagesStreamMapper } from "../open-sse/transport/protocols/anthropic";
import { buildMessagesPayload } from "../open-sse/translate/request/anthropic";
import { mapAnthropicUsage } from "../open-sse/translate/response/anthropic";
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
 * AgentRouter — free-credits ($200 on signup) multi-model gateway speaking
 * native Anthropic Messages (https://agentrouter.org/v1/messages?beta=true).
 * AgentRouter gates on client identity: it only accepts requests that look
 * like the real Claude Code CLI, so the fixed User-Agent, Stainless
 * fingerprint, beta flags, and session id below are required, not cosmetic —
 * dropping any of them gets requests rejected upstream.
 */

const AGENTROUTER_URL = "https://agentrouter.org/v1/messages?beta=true";

// Field order AgentRouter's client-identity check expects a genuine Claude
// Code CLI request body to arrive in.
const BODY_FIELD_ORDER = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "thinking",
  "output_config",
  "stream",
] as const;

function reorderBody(body: Record<string, unknown>): Record<string, unknown> {
  const reordered: Record<string, unknown> = {};
  const remaining = new Set(Object.keys(body));
  for (const key of BODY_FIELD_ORDER) {
    if (key in body) {
      reordered[key] = body[key];
      remaining.delete(key);
    }
  }
  for (const key of remaining) reordered[key] = body[key];
  return reordered;
}

function buildHeaders(apiKey: string, stream: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": "claude-cli/2.1.195 (external, sdk-cli)",
    "x-claude-code-session-id": crypto.randomUUID(),
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "0.94.0",
    "x-stainless-os": "MacOS",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    accept: stream ? "text/event-stream" : "application/json",
    "accept-encoding": "gzip, deflate, br, zstd",
    "x-api-key": apiKey,
  };
}

const AGENTROUTER_SURFACES: readonly Surface[] = ["anthropic-messages"];

const AGENTROUTER_MODELS: readonly ProviderModel[] = [
  modelOf("claude-opus-4-8", "Claude Opus 4.8", capabilitiesOf({ surfaces: AGENTROUTER_SURFACES, reasoning: true, images: true })),
];

const AGENTROUTER_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({
  surfaces: AGENTROUTER_SURFACES,
  reasoning: true,
  images: true,
});

/** AgentRouter speaks native Anthropic Messages behind its client-identity gate. */
export class AgentRouterAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "agentrouter",
    displayName: "AgentRouter",
    protocol: "anthropic",
    credentialKind: "api_key",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(AGENTROUTER_MODELS);
  readonly capabilities: ProviderCaps = {
    ...AGENTROUTER_FALLBACK_CAPABILITIES,
    streaming: true,
  };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (this.models.get(modelId) === null) {
      throw new ProviderAdapterError({
        kind: "model_not_found",
        message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`,
        statusCode: 404,
        routeScope: "provider",
      });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "anthropic-messages") {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" only supports the Anthropic Messages surface`,
        statusCode: 400,
        routeScope: null,
      });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({
        kind: "authentication_failed",
        message: "AgentRouter requires an API key.",
        statusCode: 401,
        routeScope: "account",
      });
    }
    const request = { ...input.request, model: input.target.upstreamModelId };
    const modelCapabilities = resolveModelCapabilities(this.capabilities, this.models.get(input.target.modelId), input.target.surface);
    const payload = reorderBody(buildMessagesPayload(request, this.capabilities, { includeContextManagement: false, modelCapabilities }));
    const headers = buildHeaders(input.credential, request.stream);
    const { signal, network } = input;
    const coordinator = new AbortCoordinator(signal, {
      connectTimeoutMs: request.limits.connectTimeoutMs,
      totalTimeoutMs: request.limits.totalTimeoutMs,
    });
    let streamHandedOff = false;
    try {
      let response = await executeFetch(AGENTROUTER_URL, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
      if (!response.ok) {
        try {
          await readUpstreamError(response);
        } catch (error) {
          const rejection = error instanceof ProviderAdapterError ? classifyCompatibilityRejection(error.toProviderCallError()) : null;
          if (rejection === null || !rejection.retryable || !removeCompatibilityProjection(payload, rejection)) throw error;
          recordCompatibilityFallback(input, rejection);
          response = await executeFetch(AGENTROUTER_URL, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, network, input.capture);
        }
      }
      if (!response.ok) throw await readUpstreamError(response);
      if (!request.stream) {
        const body = await readJsonObject(response, coordinator);
        const usageRecord = isRecord(body.usage) ? body.usage : null;
        return { mode: "non_stream", body, usage: usageRecord !== null ? mapAnthropicUsage(usageRecord) : undefined };
      }
      if (!response.body) {
        throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Upstream returned an empty stream body", routeScope: "provider" });
      }
      streamHandedOff = true;
      return {
        mode: "stream",
        events: mapSseStream(
          { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs },
          createAnthropicMessagesStreamMapper(),
        ),
      };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}

export const agentRouterModelCatalog = AGENTROUTER_MODELS;

