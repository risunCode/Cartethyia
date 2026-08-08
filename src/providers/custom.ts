import type { ContextStats, Adapter, ProviderCaps, ProviderMeta, ProviderModel, ProviderModelCatalog, ProviderOutput, ProviderRequest, Surface, RouteTarget, TokenCountInput } from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";
import type { CustomProviderRecord, CustomProviderRepository } from "../storage";
import { AbortCoordinator, ProviderAdapterError, aggregateCapabilities, capabilitiesOf, categoriesOf, executeFetch, isRecord, lineLimit, mapSseStream, modelOf, nullableNumber, readJsonObject, readUpstreamError, toProviderCallError } from "../open-sse/transport/shared";
import { createAnthropicMapper } from "../open-sse/transport/protocols/anthropic";
import { buildMessagesPayload, mapAnthropicUsage } from "../open-sse/translate/codecs/anthropic-messages";
import { createChatMapper } from "../open-sse/transport/protocols/openai";
import { buildChatPayload, mapChatUsage } from "../open-sse/translate/codecs/openai-chat";
import { assertPublicUrlAtDispatch } from "../security/ssrf-guard";
import type { ProviderRegistry } from "./registry";

/**
 * Custom Providers (REQ-8) — runtime-registered adapters driven by
 * `config.customProviders` rows instead of compiled modules. A record's
 * `slug` IS the adapter id, so callers address it exactly like legacy:
 * `<slug>/<model>`, and the route snapshot's prefix map picks it up without
 * extra wiring.
 *
 * `openai-compatible` speaks the Chat Completions wire shape.
 * `anthropic-compatible` speaks the Anthropic Messages wire shape. Both are
 * exposed through the shared cross-protocol boundary, so client surfaces are
 * translated before the request reaches the configured upstream.
 *
 * Credentials are selected from the provider account repository and arrive
 * through the standard CredentialSelector lease path. The provider record is
 * re-read at every call so URL/config changes and deletion apply immediately;
 * the base URL is SSRF-checked at dispatch.
 */

const CUSTOM_OPENAI_SURFACES: readonly Surface[] = ["openai-chat"];
const CUSTOM_ANTHROPIC_SURFACES: readonly Surface[] = ["anthropic-messages"];

/** Model ids discovered offline are rounded off to the provider's native surface. */

/** Read side of the custom provider repository (list + slug lookup). */
export type CustomProviderSource = Pick<CustomProviderRepository, "list" | "getBySlug">;

/**
 * Turns stored discovered-model records (objects with `id`, plain ids, or
 * legacy display-name entries) into application ProviderModels. Malformed
 * entries are dropped, and an empty list means "any model id is accepted",
 * matching legacy.
 */
function storedModels(models: readonly unknown[], capabilities: ProviderCaps): readonly ProviderModel[] {
  const result: ProviderModel[] = [];
  for (const value of models) {
    if (typeof value === "string") {
      if (value.length > 0) result.push(modelOf(value, value, capabilities));
      continue;
    }
    if (!isRecord(value)) continue;
    const id = value["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    const name = typeof value["name"] === "string" ? value["name"] : typeof value["displayName"] === "string" ? value["displayName"] : id;
    result.push(modelOf(id, name, capabilities));
  }
  return result;
}

/**
 * Catalog that always answers: stored models are listed (console display),
 * and `get` returns a synthetic entry for any id so routing stays
 * permissive exactly like legacy (catalog is informational, not a gate).
 */
function createCustomCatalog(models: readonly ProviderModel[], capabilities: ProviderCaps): ProviderModelCatalog {
  const byId = new Map(models.map((model) => [model.id, model]));
  return {
    list: Object.freeze([...models]),
    get: (modelId: string): ProviderModel =>
      byId.get(modelId) ?? {
        id: modelId,
        displayName: modelId,
        capabilities,
        context: { inputTokens: null, outputTokens: null },
        categories: categoriesOf(capabilities),
        pricing: { inputPerMillion: null, outputPerMillion: null },
      },
  };
}

export class CustomProviderAdapter implements Adapter {
  readonly metadata: ProviderMeta;
  readonly capabilities: ProviderCaps;
  readonly models: ProviderModelCatalog;
  private readonly record: CustomProviderRecord;
  private readonly source: CustomProviderSource;

  constructor(record: CustomProviderRecord, source: CustomProviderSource) {
    this.record = record;
    this.source = source;
    const nativeSurfaces = record.type === "anthropic-compatible" ? CUSTOM_ANTHROPIC_SURFACES : CUSTOM_OPENAI_SURFACES;
    const fallbackCapabilities = capabilitiesOf({ surfaces: nativeSurfaces });
    const models = storedModels(record.models, fallbackCapabilities);
    this.models = createCustomCatalog(models, fallbackCapabilities);
    this.capabilities = aggregateCapabilities(models, fallbackCapabilities);
    this.metadata = {
      id: record.slug,
      displayName: record.name,
      protocol: record.type === "anthropic-compatible" ? "anthropic" : "openai",
      credentialKind: "api_key",
    };
  }

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({
        kind: "capability_unsupported",
        message: `Provider "${this.metadata.id}" does not support surface "${surface}"`,
        statusCode: 400,
        routeScope: null,
      });
    }
    // Legacy parity: custom providers accept arbitrary upstream model ids.
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    this.assertSupported(input);
    const record = this.source.getBySlug(this.metadata.id);
    if (record === null) {
      throw new ProviderAdapterError({ kind: "invalid_request", message: `Custom provider "${this.metadata.id}" no longer exists.`, statusCode: 404, routeScope: "provider" });
    }
    const baseUrl = record.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/${record.type === "anthropic-compatible" ? "messages" : "chat/completions"}`;
    // SSRF validation always runs first, per dispatch, before any bytes
    // leave the process (the base URL is operator-supplied).
    await assertPublicUrlAtDispatch(url, { label: `Custom provider "${record.name}" base URL` });
    const coordinator = new AbortCoordinator(input.signal, {
      connectTimeoutMs: input.request.limits.connectTimeoutMs,
      // The operator-configured timeout caps the request; it can only ever
      // shorten the pipeline default, never extend it.
      totalTimeoutMs: Math.min(input.request.limits.totalTimeoutMs, Math.max(1, record.timeoutSeconds) * 1000),
    });
    let streamHandedOff = false;
    try {
      const { request } = input;
      const anthropic = record.type === "anthropic-compatible";
      const headers = customHeaders(record, input.credential, request.stream, input.headers);
      const payload = anthropic ? buildMessagesPayload(request, this.capabilities) : buildChatPayload(request);
      const response = await executeFetch(url, { method: "POST", headers, body: JSON.stringify(payload) }, coordinator, input.network, input.capture);
      if (!response.ok) throw await readUpstreamError(response);
      if (!request.stream) {
        const body = await readJsonObject(response, coordinator);
        const usageRecord = isRecord(body.usage) ? body.usage : null;
        return {
          mode: "non_stream",
          body,
          usage: usageRecord !== null
            ? anthropic ? mapAnthropicUsage(usageRecord) : mapChatUsage(usageRecord)
            : undefined,
        };
      }
      if (!response.body) {
        throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Upstream returned an empty stream body", routeScope: "provider" });
      }
      streamHandedOff = true;
      const sse = { body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs };
      return { mode: "stream", events: anthropic ? mapSseStream(sse, createAnthropicMapper()) : mapSseStream(sse, createChatMapper()) };
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

  private assertSupported(input: ProviderRequest): void {
    if (input.target.providerId !== this.metadata.id) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Adapter "${this.metadata.id}" cannot serve provider "${input.target.providerId}"`, statusCode: 400, routeScope: null });
    }
    if (!this.capabilities.surfaces.includes(input.target.surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${input.target.surface}"`, statusCode: 400, routeScope: null });
    }
    if (input.request.stream && !this.capabilities.streaming) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support streaming`, statusCode: 400, routeScope: null });
    }
  }
}

/**
 * Custom provider outbound headers. The stored credential is used and custom
 * headers apply LAST so an operator's org/routing/WAF-bypass header wins on
 * collision (legacy rule).
 */
/** Headers that operators must not override via custom provider config —
 *  they control routing, auth, or connection semantics and could be used
 *  for header injection / SSRF bypass if allowed. */
const BLOCKED_CUSTOM_HEADERS = new Set([
  "host",
  "authorization",
  "cookie",
  "set-cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "origin",
  "referer",
  "content-length",
  "transfer-encoding",
  "connection",
]);

function customHeaders(record: CustomProviderRecord, credential: string, stream: boolean, incoming: Headers | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
  if (record.type === "anthropic-compatible") {
    headers["x-api-key"] = credential;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${credential}`;
  }
  const userAgent = incoming?.get("user-agent");
  if (userAgent) headers["user-agent"] = userAgent;
  for (const [name, value] of Object.entries(record.customHeaders)) {
    const lower = name.toLowerCase();
    if (name.length === 0 || BLOCKED_CUSTOM_HEADERS.has(lower)) continue;
    // Reject header names with CRLF characters (injection prevention)
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
    headers[lower] = value;
  }
  return headers;
}

/**
 * Reconciles the runtime registry with the configured custom provider
 * records: registers (or refreshes) one adapter per record, keyed by slug,
 * and unregisters adapters whose records were deleted. Called once at
 * startup and after every console custom-provider mutation; the mutation
 * wrapper also bumps the routing revision so the route snapshot rebuilds.
 */
export function syncCustomAdapters(registry: ProviderRegistry, source: CustomProviderSource): void {
  const live = new Set<string>();
  for (const record of source.list()) {
    live.add(record.slug);
    const existing = registry.get(record.slug);
    if (existing !== null && !(existing instanceof CustomProviderAdapter)) continue;
    if (existing !== null) registry.unregister(record.slug);
    registry.register(new CustomProviderAdapter(record, source));
  }
  for (const adapter of registry.list()) {
    if (adapter instanceof CustomProviderAdapter && !live.has(adapter.metadata.id)) {
      registry.unregister(adapter.metadata.id);
    }
  }
}