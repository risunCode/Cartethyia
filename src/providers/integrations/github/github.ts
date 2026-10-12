/**
 * GitHub Copilot adapter.
 *
 * Copilot is an OpenAI-compatible chat surface, but not a fixed one: the API
 * host is per-account and is read out of the Copilot token's `proxy-ep` claim,
 * so an Individual account and an enterprise account post to different hosts.
 * That is why this is a bespoke adapter rather than a declarative spec — the
 * `base_url` a spec carries is fixed at registration, and the routing layer
 * resolves one base URL per provider, not per account.
 *
 * The credential is a `{access, apiHost}` envelope for the same reason the
 * host is not a constant: the value stored at login is the only place the
 * account's host is recorded.
 */
import { createHash, randomUUID } from "node:crypto";
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import { GatewayError } from "../../../protocol/gateway-error";
import { isRecord } from "../../../protocol/codecs";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { allParts, type CanonicalEvent, type CanonicalRequest, type ContentPart } from "../../../protocol/canonical-model";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../compatible-adapter";
import { postUpstreamJson } from "../../../protocol/upstream/post-json";
import { providerBaseUrl } from "../../metadata";
import { getOrCreateInstallId } from "../shared/install-id";
import { applyParamQuirks } from "../../../transport/translation/quirks";
import { resolveInboundSessionId } from "../../operations/session-resolution";
import {
  GITHUB_REQUEST_HEADERS,
  parseGithubCredential,
} from "./github-oauth";

export const GITHUB_PROVIDER_ID = "github" as const;

/** Chat surface. The static fallback rows are all chat. */
export const GITHUB_ENDPOINT_PATH = "/chat/completions" as const;

/**
 * Responses surface. Copilot serves some SKUs only on `/responses`, so a
 * discovered row declares this path and the shared pipeline routes the request
 * here rather than failing on the chat endpoint.
 */
export const GITHUB_RESPONSES_ENDPOINT_PATH = "/responses" as const;

/**
 * Long-context tier marker.
 *
 * A request for a SKU whose window is at or above the long-context threshold
 * carries this field so Copilot serves it from the long-context pool. It is a
 * Copilot-specific extension, not an OpenAI field, and the native Anthropic
 * surface rejects it as an unknown top-level key — so it is injected only on
 * the chat and responses wires, and only when the account's own catalog reports
 * a qualifying window.
 */
export const GITHUB_CONTEXT_TIER = "long_context" as const;

/** Context window at or above which the account is served from the long tier. */
export const GITHUB_LONG_CONTEXT_THRESHOLD = 500_000;

/** Supported virtual Copilot Auto catalog ids and their router tiers. */
export const GITHUB_AUTO_MODEL_TIERS: ReadonlyMap<string, "efficiency" | "balance" | "intelligence"> = new Map([
  ["auto", "balance"],
  ["gpt-6-luna-low", "efficiency"],
  ["gpt-6-luna-medium", "balance"],
  ["gpt-6-luna-high", "intelligence"],
]);

/** Copilot model ids excluded from both the fallback and discovered catalogs. */
export const GITHUB_EXCLUDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "copilot-search-c",
  "exec-agent-a",
  "exec-agent-b",
  "exec-agent-c",
  "gpt-5.4-mini-free-auto",
  "gpt-5.6-luna",
  "gpt-5.6-luna-free-auto",
  "gpt-6-luna",
  "kimi-k3",
  "kimi-k3-base",
  "kimi-k3-copilot",
  "mai-code-1-flash-4th",
  "mai-code-1-flash-secondary",
  "mai-code-1-flash-tertiary",
  "mai-code-1.1-flash",
]);

/**
 * Long-context models reported by each account's own model directory.
 */
const longContextModelIdsByCredential = new Map<string, ReadonlySet<string>>();
const modelRoutesByCredential = new Map<string, ReadonlyMap<string, GithubModelRoute>>();
const GITHUB_AUTO_SESSION_CACHE_MAX_ENTRIES = 50;
const GITHUB_AUTO_SESSION_EXPIRY_SKEW_MS = 5 * 60 * 1_000;

export interface GithubModelRoute {
  readonly wireFamily: "chat" | "responses";
  readonly endpointPath: string;
}

function githubCredentialKey(value: string): string | undefined {
  try {
    const credential = parseGithubCredential(value);
    return createHash("sha256")
      .update(`${credential.apiHost}:${credential.github ?? credential.access}`)
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Whether this account's catalog reported `modelId` at the long-context tier. */
export function githubModelUsesLongContext(modelId: string, credential: string): boolean {
  const key = githubCredentialKey(credential);
  if (key === undefined) return false;
  return longContextModelIdsByCredential.get(key)?.has(modelId.toLowerCase()) === true;
}

/** Replaces the account's long-context roster with the latest discovery result. */
export function recordGithubLongContextModels(
  credential: string,
  models: readonly ModelDefinition[],
): void {
  const key = githubCredentialKey(credential);
  if (key === undefined) return;
  longContextModelIdsByCredential.set(
    key,
    new Set(
      models
        .filter(
          (model) =>
            model.contextLimit !== null &&
            model.contextLimit >= GITHUB_LONG_CONTEXT_THRESHOLD,
        )
        .map((model) => model.modelId.toLowerCase()),
    ),
  );
}

/** Replaces this account's discovered model-to-endpoint routing map. */
export function recordGithubModelRoutes(
  credential: string,
  models: readonly ModelDefinition[],
): void {
  const key = githubCredentialKey(credential);
  if (key === undefined) return;
  const routes = models
    .filter(
      (model): model is ModelDefinition & { readonly wireFamily: "chat" | "responses" } =>
        model.wireFamily === "chat" || model.wireFamily === "responses",
    )
    .map((model) => [
      model.modelId.toLowerCase(),
      { wireFamily: model.wireFamily, endpointPath: model.endpointPath },
    ] as const);
  modelRoutesByCredential.set(key, new Map(routes));
}

/** Looks up an inference surface reported by this account's model directory. */
export function githubModelRoute(
  modelId: string,
  credential: string,
): GithubModelRoute | undefined {
  const key = githubCredentialKey(credential);
  if (key === undefined) return undefined;
  return modelRoutesByCredential.get(key)?.get(modelId.toLowerCase());
}

function isAgentInitiated(request: CanonicalRequest): boolean {
  const lastMessage = request.messages.at(-1);
  if (!lastMessage) return false;
  if (lastMessage.role === "assistant" || lastMessage.role === "tool") return true;
  return lastMessage.content.length > 0 &&
    lastMessage.content.every((part) => part.kind === "toolResult");
}

function containsImage(part: ContentPart): boolean {
  if (part.kind === "image") return true;
  return part.kind === "toolResult" &&
    Array.isArray(part.content) &&
    part.content.some(containsImage);
}

function autoPromptPart(part: ContentPart): string {
  switch (part.kind) {
    case "text":
    case "refusal":
      return part.text;
    case "toolCall":
      return `Tool call ${part.name}: ${JSON.stringify(part.arguments)}`;
    case "toolResult":
      return typeof part.content === "string"
        ? part.content
        : part.content.map(autoPromptPart).filter(Boolean).join("\n");
    case "image":
      return "[image attached]";
    case "file":
      return `[file${part.filename ? `: ${part.filename}` : ""}]`;
    case "document":
      return `[document${part.title ? `: ${part.title}` : ""}]`;
    case "audio":
      return "[audio attached]";
    case "reasoning":
      return part.summary ?? "";
    case "extension":
      return "";
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

interface GithubAutoPrompt {
  readonly prompt: string;
  readonly hasImage: boolean;
}

function autoPrompt(request: CanonicalRequest): GithubAutoPrompt {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    const parts = message.content.filter(
      (part) => part.kind !== "toolCall" && part.kind !== "toolResult" &&
        part.kind !== "reasoning" && part.kind !== "extension",
    );
    const prompt = parts.map(autoPromptPart).filter(Boolean).join("\n");
    if (prompt.length === 0) continue;
    return {
      prompt,
      hasImage: parts.some(containsImage),
    };
  }
  return { prompt: "", hasImage: false };
}

interface GithubAutoDecision {
  readonly modelId: string;
  readonly sessionToken: string;
  readonly expiresAt: number;
  readonly hasImage: boolean;
}

interface CopilotModelOptions {
  readonly vision?: boolean;
  readonly reasoning?: boolean;
}

function copilotModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: CopilotModelOptions = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: GITHUB_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: GITHUB_ENDPOINT_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? false,
    reasoning: options.reasoning ?? false,
    toolCall: true,
  });
}

export const GITHUB_AUTO_MODELS: readonly ModelDefinition[] = [
  ...[...GITHUB_AUTO_MODEL_TIERS.keys()].map((modelId) =>
    copilotModel(modelId, 1_000_000, 64_192, { vision: true, reasoning: true }),
  ),
];

/**
 * Static fallback catalog.
 *
 * The authoritative list is the account's own `/models` response, which reports
 * exactly which SKUs the subscription may use — so this list is the offline
 * floor, not the truth. It includes models verified reachable on the
 * `vscode-chat` integration. Models that failed reachability checks or are
 * still being tested are deliberately excluded. Limits come from the models.dev
 * base catalog where it knows the id (the ids here are the upstream vendors'
 * own).
 */
export const GITHUB_MODELS: readonly ModelDefinition[] = [
  ...GITHUB_AUTO_MODELS,
  copilotModel("gpt-4.1", 128_000, 32_768, { vision: true }),
  copilotModel("gpt-4o", 128_000, 16_384, { vision: true }),
  copilotModel("gpt-4o-mini", 128_000, 16_384, { vision: true }),
  copilotModel("gpt-3.5-turbo-0613", 16_385, 4_096),
  // Fireworks-hosted agent SKUs. `billing.restricted_to` on the account's own
  // catalog includes `free`, so they are usable without a paid plan.
  copilotModel("copilot-search-a", 260_000, 16_000),
  copilotModel("copilot-search-b", 260_000, 16_000),
];

/**
 * Adapter that derives its host and headers from the stored credential.
 *
 * `prepareHeaders` and the URL are both corrected rather than rebuilt: payload
 * translation, transport, SSE decoding, and error mapping stay with the shared
 * pipeline, so only the two Copilot-specific facts (the host and the client
 * identity) are supplied here.
 */
class GithubAdapter extends OpenAICompatibleAdapter {
  readonly #fallbackBaseUrl: string;
  /**
   * Transport seam, held here because this adapter issues its own request: the
   * shared config's `fetch` is private, and ignoring it would send a test's
   * injected transport to the real network.
   */
  readonly #fetch: typeof fetch | undefined;
  readonly #autoSessionTokens = new WeakMap<CanonicalRequest, string>();
  readonly #autoDecisions = new Map<string, GithubAutoDecision>();

  constructor(fallbackBaseUrl: string, fetchImpl?: typeof fetch) {
    super(
      withBearerAuthentication({
        provider_id: GITHUB_PROVIDER_ID,
        base_url: fallbackBaseUrl,
        endpoint_paths_by_wire_family: {
          chat: GITHUB_ENDPOINT_PATH,
          responses: GITHUB_RESPONSES_ENDPOINT_PATH,
        },
        // The long-context tier is a Copilot request extension, injected only
        // for a model the account's own catalog reported at or above the
        // threshold. `contextTier` is applied after wire translation so it
        // rides on the serialized body the upstream actually reads.
        prePayload: (payload, request, candidate, context) => {
          if (
            this.#autoSessionTokens.has(request) &&
            candidate.wire_family === "responses"
          ) {
            const reasoning = payload["reasoning"];
            if (!isRecord(reasoning)) {
              payload["reasoning"] = { summary: "detailed" };
            } else if (
              reasoning["summary"] === undefined ||
              reasoning["summary"] === "auto"
            ) {
              payload["reasoning"] = { ...reasoning, summary: "detailed" };
            }
          }
          const secret = context.credential.secret;
          if (
            secret === undefined ||
            !githubModelUsesLongContext(request.model, new TextDecoder().decode(secret))
          ) return;
          // Only the OpenAI-shaped surfaces accept the extension; the native
          // Anthropic surface validates against its own schema and rejects an
          // unknown top-level key. The candidate's wire family decides.
          if (candidate.wire_family !== "chat" && candidate.wire_family !== "responses") return;
          if (payload.contextTier !== undefined) return;
          payload.contextTier = GITHUB_CONTEXT_TIER;
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    );
    this.#fallbackBaseUrl = fallbackBaseUrl;
    this.#fetch = fetchImpl;
  }

  override async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const tier = GITHUB_AUTO_MODEL_TIERS.get(candidate.model_id.toLowerCase());
    if (tier === undefined) {
      yield* super.dispatch(request, candidate, context);
      return;
    }

    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) {
      throw new GatewayError("authentication_failed", 401, "GitHub Copilot credential is missing");
    }
    const credential = new TextDecoder().decode(secret);
    const autoInput = autoPrompt(request);
    const sessionId = resolveInboundSessionId(context, request);
    const cacheKey = sessionId === undefined || sessionId.startsWith("aff_")
      ? undefined
      : this.#autoDecisionCacheKey(credential, sessionId, tier);
    let autoDecision = cacheKey === undefined
      ? undefined
      : this.#getCachedAutoDecision(cacheKey, autoInput.hasImage);
    if (autoDecision === undefined) {
      if (autoInput.prompt.length === 0) {
        throw new GatewayError("invalid_request", 400, "Copilot Auto requires a text prompt");
      }
      autoDecision = await this.#selectAutoModel(
        autoInput.prompt,
        tier,
        autoInput.hasImage,
        request,
        candidate,
        context,
      );
      if (cacheKey !== undefined) this.#cacheAutoDecision(cacheKey, autoDecision);
    }
    const selectedModelId = autoDecision.modelId;
    let route = githubModelRoute(selectedModelId, credential);
    if (route === undefined) {
      const { discoverGithubModels } = await import("./github-discovery");
      const outboundFetch = context.outbound_fetch;
      const fetcher = outboundFetch === undefined
        ? this.#fetch ?? globalThis.fetch
        : Object.assign(
            (input: RequestInfo | URL, init?: RequestInit) => outboundFetch(input, init),
            { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) },
          );
      await discoverGithubModels({
        credential,
        fetcher,
        signal: context.abort_signal,
      });
      if (context.abort_signal.aborted) throw context.abort_signal.reason;
      route = githubModelRoute(selectedModelId, credential);
    }
    if (route === undefined) {
      throw new GatewayError(
        "upstream_unprocessable",
        502,
        "Copilot Auto selected a model without a discovered inference endpoint",
        { selected_model: selectedModelId },
        "upstream",
      );
    }

    const routedRequest = applyParamQuirks(
      { ...request, model: selectedModelId },
      candidate.provider_id,
    );
    this.#autoSessionTokens.set(routedRequest, autoDecision.sessionToken);
    yield* super.dispatch(
      routedRequest,
      {
        ...candidate,
        model_id: selectedModelId,
        wire_family: route.wireFamily,
        endpoint_path: route.endpointPath,
      },
      context,
    );
  }

  async #selectAutoModel(
    prompt: string,
    tier: "efficiency" | "balance" | "intelligence",
    hasImage: boolean,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<GithubAutoDecision> {
    const headers = await this.prepareHeaders(context, request, candidate);
    const credential = context.credential.secret === undefined
      ? undefined
      : parseGithubCredential(new TextDecoder().decode(context.credential.secret));
    if (credential === undefined) {
      throw new GatewayError("authentication_failed", 401, "GitHub Copilot credential is missing");
    }
    const payload: Record<string, unknown> = { prompt, tier };
    if (hasImage) payload.has_image = true;
    const outboundFetch = context.outbound_fetch ?? this.#fetch ?? globalThis.fetch;
    const upstream = await postUpstreamJson(
      `https://${credential.apiHost}/auto`,
      headers,
      payload,
      context,
      outboundFetch,
    );
    let responsePayload: unknown;
    try {
      if (!upstream.res.ok) {
        await mapUpstreamHttpError(upstream.res, GITHUB_PROVIDER_ID);
      }
      responsePayload = await upstream.res.json();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (context.abort_signal.aborted || upstream.signal.aborted) throw error;
      throw new GatewayError(
        "upstream_unprocessable",
        502,
        "Copilot Auto returned an invalid routing response",
        {},
        "upstream",
      );
    } finally {
      upstream.release();
    }
    if (
      typeof responsePayload !== "object" ||
      responsePayload === null ||
      !("selected_model" in responsePayload) ||
      typeof responsePayload.selected_model !== "object" ||
      responsePayload.selected_model === null ||
      !("id" in responsePayload.selected_model) ||
      typeof responsePayload.selected_model.id !== "string" ||
      responsePayload.selected_model.id.trim().length === 0 ||
      !("session_token" in responsePayload) ||
      typeof responsePayload.session_token !== "string" ||
      responsePayload.session_token.trim().length === 0
    ) {
      throw new GatewayError(
        "upstream_unprocessable",
        502,
        "Copilot Auto did not return a selected model",
        {},
        "upstream",
      );
    }
    const expiresAt =
      "expires_at" in responsePayload &&
      typeof responsePayload.expires_at === "number" &&
      Number.isFinite(responsePayload.expires_at)
        ? responsePayload.expires_at
        : 0;
    return {
      modelId: responsePayload.selected_model.id.trim(),
      sessionToken: responsePayload.session_token.trim(),
      expiresAt,
      hasImage,
    };
  }

  #autoDecisionCacheKey(
    credentialValue: string,
    sessionId: string,
    tier: "efficiency" | "balance" | "intelligence",
  ): string {
    const credential = parseGithubCredential(credentialValue);
    const account = createHash("sha256")
      .update(`${credential.apiHost}:${credential.access}`)
      .digest("hex");
    return `${account}:${tier}:${sessionId}`;
  }

  #getCachedAutoDecision(
    cacheKey: string,
    hasImage: boolean,
  ): GithubAutoDecision | undefined {
    const decision = this.#autoDecisions.get(cacheKey);
    if (decision === undefined) return undefined;
    if (
      decision.expiresAt * 1_000 - Date.now() < GITHUB_AUTO_SESSION_EXPIRY_SKEW_MS ||
      (hasImage && !decision.hasImage)
    ) {
      this.#autoDecisions.delete(cacheKey);
      return undefined;
    }
    this.#autoDecisions.delete(cacheKey);
    this.#autoDecisions.set(cacheKey, decision);
    return decision;
  }

  #cacheAutoDecision(cacheKey: string, decision: GithubAutoDecision): void {
    if (
      decision.expiresAt * 1_000 - Date.now() < GITHUB_AUTO_SESSION_EXPIRY_SKEW_MS
    ) return;
    this.#autoDecisions.delete(cacheKey);
    if (this.#autoDecisions.size >= GITHUB_AUTO_SESSION_CACHE_MAX_ENTRIES) {
      const oldestKey = this.#autoDecisions.keys().next().value;
      if (oldestKey !== undefined) this.#autoDecisions.delete(oldestKey);
    }
    this.#autoDecisions.set(cacheKey, decision);
  }

  /** The account's host, or the provider default when the credential is unreadable. */
  #baseUrl(context: ProviderDispatchContext): string {
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return this.#fallbackBaseUrl;
    try {
      return `https://${parseGithubCredential(new TextDecoder().decode(secret)).apiHost}`;
    } catch {
      return this.#fallbackBaseUrl;
    }
  }

  protected override async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
    const headers = await super.prepareHeaders(context, request, candidate);
    // The Copilot API rejects a request that does not identify a Copilot
    // client, so these are a protocol requirement. `applyRouteUserAgent` has
    // already run inside the shared pipeline, so the identity is stamped after
    // it and wins — the route-level User-Agent is for generic OpenAI-compatible
    // hosts and would be rejected here.
    Object.assign(headers, GITHUB_REQUEST_HEADERS);
    const autoSessionToken = this.#autoSessionTokens.get(request);
    if (autoSessionToken !== undefined) {
      headers["copilot-session-token"] = autoSessionToken;
    }
    const requestId = context.request_id ?? randomUUID();
    Object.assign(headers, {
      "editor-device-id": await getOrCreateInstallId("github"),
      "openai-intent": "conversation-agent",
      "x-agent-task-id": requestId,
      "x-initiator": isAgentInitiated(request) ? "agent" : "user",
      "x-interaction-type": "conversation-agent",
      "x-request-id": requestId,
    });
    if (allParts(request).some(containsImage)) {
      headers["copilot-vision-request"] = "true";
    } else {
      delete headers["copilot-vision-request"];
    }
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return headers;
    try {
      const { access } = parseGithubCredential(new TextDecoder().decode(secret));
      headers.authorization = `Bearer ${access}`;
    } catch {
      // Left as the factory sent it: the request fails closed at the upstream
      // auth boundary, and the parse error belongs to the credential boundary.
    }
    return headers;
  }

  protected override async executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    _request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ): Promise<Response> {
    // The host comes from the credential, which the shared config cannot see,
    // so the request is issued here against the resolved base URL instead of
    // the registered one. Everything else — the payload, the headers, the
    // deadline lifecycle — is what the shared pipeline produced.
    const endpointPath = candidate?.endpoint_path && candidate.endpoint_path.length > 0
      ? candidate.endpoint_path
      : GITHUB_ENDPOINT_PATH;
    const url = `${this.#baseUrl(context).replace(/\/+$/, "")}${endpointPath}`;
    const outboundFetch = context.outbound_fetch ?? this.#fetch ?? globalThis.fetch;
    const { postUpstreamJson } = await import("../../../protocol/upstream/post-json");
    const upstream = await postUpstreamJson(url, headers, payload as Record<string, unknown>, context, outboundFetch);
    upstream.release();
    return upstream.res;
  }
}

/** GitHub Copilot provider adapter. */
export const githubAdapter: ProviderAdapter = new GithubAdapter(
  providerBaseUrl(GITHUB_PROVIDER_ID),
);
