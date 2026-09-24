import { GatewayError } from "../transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../transport/canonical-model";
import { throwIfHtmlResponse, mapUpstreamHttpError, extractUpstreamMessage, extractHtmlTitle, upstreamProviderCode } from "../transport/failure-policy";
import type {
  ProviderAdapter,
  ProviderDispatchTarget,
  ProviderId,
  ProviderDispatchContext,
} from "./provider-registry";
import { createUpstreamDeadlineLifecycle } from "./operations/upstream-deadline";
import { encodeWireRequest, decodeWireResponse, decodeWireStream } from "../protocol/registry";
import { postUpstreamJson } from "../protocol/transport/openai";
import { GATEWAY_USER_AGENT } from "./operations/gateway-user-agent";
import {
  BUILTIN_DEFAULT_ENDPOINTS,
  filterProviderCustomHeaders,
  joinUrl,
  normalizeBearerToken,
  type AuthHeaderShape,
} from "../protocol/primitives";
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/** Shared template-method lifecycle for HTTP-backed provider adapters. */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract readonly provider_id: ProviderId;
  protected abstract get supportedFamilies(): readonly WireFamily[];

  async *dispatch(
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (request.model.includes("?")) {
      throw new GatewayError("invalid_request", 400, "model must not contain query string");
    }
    if (this.supportedFamilies.length > 0 && !this.supportedFamilies.includes(target.wire_family)) {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `${this.provider_id} supports only wire family "${this.supportedFamilies.join(", ")}", got "${target.wire_family}"`,
        { provider: this.provider_id, wire_family: target.wire_family },
      );
    }

    const headers = await this.prepareHeaders(context, request, target);
    const payload = await this.preparePayload(request, target);
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const transportContext: ProviderDispatchContext = { ...context, abort_signal: lifecycle.signal };
    try {
      const response = await this.executeTransport(headers, payload, transportContext, request, target);
      // The HTTP headers establish the upstream stream. The original
      // pre-stream deadline must not kill a healthy long response body; the
      // outer request watchdog now owns inter-event stall detection.
      lifecycle.release();
      yield* this.transformStream(response, request, target, transportContext);
    } catch (error: unknown) {
      if (lifecycle.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new GatewayError("transport_closed", 499, "request was cancelled");
      }
      throw error;
    } finally {
      lifecycle.release();
    }
  }

  protected abstract prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
  ): Promise<Record<string, string>>;
  protected abstract preparePayload(
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
  ): Promise<unknown>;
  protected abstract executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    request?: CanonicalRequest,
    target?: ProviderDispatchTarget,
  ): Promise<Response>;
  protected abstract transformStream(
    response: Response,
    request: CanonicalRequest,
    target: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent>;
}

export interface OpenAICompatibleAdapterConfig {
  readonly provider_id: ProviderId;
  readonly base_url: string;
  readonly authentication_header_shape: AuthHeaderShape;
  readonly endpoint_paths_by_wire_family?: Partial<Record<WireFamily, string>>;
  readonly extra_headers?: Readonly<Record<string, string>>;
  readonly extra_query_params?: Readonly<Record<string, string>>;
  readonly streaming_usage_mode?: "include_usage" | "none";
  readonly structured_output?: { readonly mode: "json_object" | "json_schema"; readonly enabled: boolean; readonly schema?: Record<string, unknown> };
  /** Whether this provider accepts OpenAI prompt cache controls on its wire. */
  readonly supports_prompt_caching?: boolean;
  /** Declared wire families this adapter serves; others reject with `capability_unsupported`. Required — adapters must declare their wire contract explicitly. */
  readonly supported_wire_families: readonly WireFamily[];
  /** Final payload mutation hook — runs after canonical translation, before serialization. Lets a provider promote extension-namespaced `generation_controls` fields (e.g. Cerebras `extra_body`) without a fetch-wrapping hack. */
  /**
   * Per-dispatch dynamic header hook, applied after `extra_headers` (so it
   * can layer on top of static config). Unlike `extra_headers`, this runs
   * once per request — for providers that need fresh per-request values
   * (e.g. OpenCode's `x-opencode-session`/`x-opencode-request` correlation
   * IDs) rather than a fixed header set.
   */
  readonly buildExtraHeaders?: (
    context: ProviderDispatchContext,
    request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /**
   * "account" (default) forwards whatever `credential_kind` the dispatched
   * account declares. "never" unconditionally withholds `Authorization`
   * regardless of account configuration — for providers with a genuinely
   * public/unauthenticated endpoint (e.g. OpenCode Free) where sending a
   * stray key would be actively wrong, not merely unnecessary. Console
   * account creation still allows any `credentialKind` for these providers;
   * this is the enforcement boundary, not account-creation validation.
   */
  readonly credential_forwarding?: "account" | "never";
  /**
   * Stamps `user-agent: Cartethyia/<version>` on every dispatch. Explicit
   * opt-in per provider spec — never a default — so first-party cloaking
   * (Codex, Claude Code) is untouched.
   */
  readonly gateway_user_agent?: boolean;
  /** Canonical request hook, applied before wire translation. Narrower than
   * `prePayload`: the returned request is what every wire codec serializes. */
  readonly prepareRequest?: (request: CanonicalRequest) => CanonicalRequest;
  readonly prePayload?: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
  /** Transport injection for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

export function withBearerAuthentication(
  decl: Omit<OpenAICompatibleAdapterConfig, "authentication_header_shape" | "fetch"> & {
    fetchImpl?: typeof fetch;
  },
): OpenAICompatibleAdapterConfig {
  const { fetchImpl, ...rest } = decl;
  return {
    ...rest,
    authentication_header_shape: "authorization_bearer",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

function resolveEndpoint(
  wireFamily: WireFamily,
  overrides?: Partial<Record<WireFamily, string>>,
): string {
  return overrides?.[wireFamily] ?? BUILTIN_DEFAULT_ENDPOINTS[wireFamily] ?? "/v1/chat/completions";
}

/**
 * Builds the credential header for one wire family's auth shape. Exported so
 * the BYOK ad-hoc connection test stamps the exact same header the adapter
 * will send at dispatch time, instead of a hand-rolled copy that can drift.
 */
export function authHeaders(
  shape: AuthHeaderShape,
  secret: Uint8Array | undefined,
  credentialKind: string,
): Record<string, string> {
  if (credentialKind === "none" || !secret || secret.length === 0) return {};
  const token = normalizeBearerToken(TEXT_DECODER.decode(secret));
  if (token.length === 0) return {};
  if (shape === "x_api_key") {
    return { "x-api-key": token };
  }
  return { authorization: `Bearer ${token}` };
}

/**
 * Concrete provider adapter implementation for the OpenAI-compatible family,
 * extending BaseProviderAdapter and implementing both /chat/completions and /v1/responses.
 */
export class OpenAICompatibleAdapter extends BaseProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly config: OpenAICompatibleAdapterConfig;

  constructor(config: OpenAICompatibleAdapterConfig) {
    super();
    this.config = config;
    this.provider_id = config.provider_id;
  }

  protected get supportedFamilies(): readonly WireFamily[] {
    return this.config.supported_wire_families;
  }

  protected async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Explicit opt-in only (`gateway_user_agent: true` on the spec): the
      // default Bun/undici agent stays for everyone else, and first-party
      // cloaking paths never pass through here.
      ...(this.config.gateway_user_agent === true ? { "user-agent": GATEWAY_USER_AGENT } : {}),
    };
    Object.assign(
      headers,
      authHeaders(
        this.config.authentication_header_shape,
        context.credential.secret,
        this.config.credential_forwarding === "never" ? "none" : context.credential.credential_kind,
      ),
    );
    if (this.config.extra_headers) Object.assign(headers, this.config.extra_headers);
    if (this.config.buildExtraHeaders) {
      // Await the hook so version-discovery-backed header builders block on
      // resolving the true latest client version instead of racing it and
      // serving the stale pinned fallback on the first dispatch.
      Object.assign(headers, await this.config.buildExtraHeaders(context, request, candidate));
    }
    Object.assign(headers, filterProviderCustomHeaders(context.credential.custom_headers));
    return headers;
  }

  protected async preparePayload(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<unknown> {
    const wireFamily = candidate.wire_family;
    const effectiveRequest = this.config.prepareRequest?.(request) ?? request;
    const payload = encodeWireRequest(wireFamily, effectiveRequest, {
      supportsPromptCaching: this.config.supports_prompt_caching !== false,
    });
    if (this.config.streaming_usage_mode !== "none" && effectiveRequest.stream) {
      // OpenAI-compatible bridges only report token usage on a stream when the
      // caller asks for it. Without this, a custom provider's streamed
      // requests record input 0 / output 0 because the upstream never sends a
      // usage frame. "none" is the explicit opt-out for bridges that reject
      // the field.
      const existing = payload["stream_options"] as Record<string, unknown> | undefined;
      payload["stream_options"] = { ...(existing ?? {}), include_usage: true };
    }
    // Apply structured_output configuration
    if (this.config.structured_output?.enabled) {
      if (this.config.structured_output.mode === "json_object") {
        payload["response_format"] = { type: "json_object" };
      } else if (this.config.structured_output.mode === "json_schema" && this.config.structured_output.schema) {
        // Only emit strict:true when a real schema was supplied by the caller
        payload["response_format"] = {
          type: "json_schema",
          json_schema: { 
            name: "response", 
            strict: true, 
            schema: this.config.structured_output.schema 
          },
        };
      } else {
        // Default to json_object for generic case without a real schema
        payload["response_format"] = { type: "json_object" };
      }
    }
    this.config.prePayload?.(payload, effectiveRequest, candidate);
    return payload;
  }

  protected async executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    _request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ): Promise<Response> {
    const wireFamily = candidate?.wire_family ?? "chat";
    const endpointPath =
      candidate?.endpoint_path && candidate.endpoint_path.length > 0
        ? candidate.endpoint_path
        : resolveEndpoint(wireFamily, this.config.endpoint_paths_by_wire_family);
    const baseEndpointUrl = joinUrl(this.config.base_url, endpointPath);
    const fetchUrl = (() => {
      if (!this.config.extra_query_params || Object.keys(this.config.extra_query_params).length === 0)
        return baseEndpointUrl;
      const u = new URL(baseEndpointUrl);
      for (const [key, value] of Object.entries(this.config.extra_query_params)) {
        u.searchParams.set(key, value);
      }
      return u.toString();
    })();
    const outboundFetch = context.outbound_fetch ?? this.config.fetch ?? globalThis.fetch;
    const upstream = await postUpstreamJson(
      fetchUrl,
      headers,
      payload as Record<string, unknown>,
      context,
      outboundFetch,
    );
    upstream.release();
    return upstream.res;
  }

  protected async *transformStream(
    res: Response,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (
      res.status === 202 &&
      candidate?.wire_family === "responses" &&
      request.provider_options?.cartethyia_probe === true
    ) {
      throw new GatewayError(
        "transport_unavailable",
        502,
        "upstream probe returned HTTP 202",
        { upstreamStatus: 202, providerCode: "rate_limit_exceeded" },
        "upstream",
      );
    }
    if (!res.ok) {
      await throwIfHtmlResponse(res);
      await mapUpstreamHttpError(res, this.provider_id);
    }
    // Edge proxies (Cloudflare etc.) can return an HTML error page with a
    // 2xx/3xx status when the origin is unreachable — surface it as a typed
    // 502 instead of a cryptic SSE/JSON decode failure.
    await throwIfHtmlResponse(res);

    const contentType = res.headers.get("content-type") ?? "";
    const wireFamily = candidate.wire_family;
    if (contentType.includes("text/event-stream")) {
      if (!res.body) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          wireFamily === "responses" ? "Responses returned empty stream" : "Chat returned empty stream",
          {},
          "upstream",
        );
      }
      yield* decodeWireStream(wireFamily, res.body, request, { signal: context.abort_signal });
    } else {
      // A streaming request answered with a non-SSE body is a provider
      // protocol violation, and the body is often an error envelope or a
      // plain-text/HTML page. `res.json()` on that threw a bare `SyntaxError`,
      // which no classifier recognizes: it reached telemetry as
      // `unknown_error` and the client as a 500 "the upstream failure could
      // not be classified" — a gateway-blaming 500 for a perfectly
      // identifiable upstream response. Parse defensively and raise a typed
      // upstream error carrying the provider's own message when there is one.
      const raw = await res.text().catch(() => "");
      let json: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("body is not a JSON object");
        }
        json = parsed as Record<string, unknown>;
      } catch {
        const summary = extractHtmlTitle(raw) || raw.trim() || `HTTP ${res.status}`;
        throw new GatewayError(
          "transport_unavailable",
          502,
          `Upstream returned a non-JSON response: ${summary}`.slice(0, 300),
          { upstreamStatus: res.status, contentType },
          "upstream",
        );
      }
      // A JSON error envelope on a 2xx is still an upstream failure: surface
      // the provider's own code/message instead of decoding it as a normal
      // completion (which would silently yield an empty response). Gated on
      // the absence of every completion shape so a provider that merely
      // echoes an `error` field alongside real output is not misread.
      const envelopeError = json["error"];
      const hasCompletionShape =
        json["choices"] !== undefined ||
        json["output"] !== undefined ||
        json["content"] !== undefined ||
        json["candidates"] !== undefined;
      if (envelopeError !== undefined && envelopeError !== null && !hasCompletionShape) {
        const message = extractUpstreamMessage(json) || "Upstream reported an error";
        const providerCode = upstreamProviderCode(json);
        throw new GatewayError(
          "transport_unavailable",
          502,
          message.slice(0, 300),
          {
            upstreamStatus: res.status,
            ...(providerCode === undefined ? {} : { providerCode }),
          },
          "upstream",
        );
      }
      for (const ev of decodeWireResponse(wireFamily, json, request)) yield ev;
    }
  }
}
