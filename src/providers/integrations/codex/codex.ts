/**
 * Dedicated `codex` adapter.
 *
 * Cartethyia's `codex` provider is ChatGPT-OAuth-family only: subscriber
 * OAuth, enterprise scoped access tokens, and workload-identity federation
 * all bill against the same ChatGPT plan credits and dispatch through the
 * same ChatGPT backend. Plain OpenAI API-key traffic is served by the
 * separate `openai` provider (`src/providers/integrations/openai.ts`) and never
 * reaches this adapter.
 *
 * Auth is consumed only from `context.credential`. Wire mechanics live in
 * `src/protocol/` plus provider-local modules:
 *   - `protocol/request/codex.ts`  — canonical → Codex Responses body + Responses Lite shape
 *   - `protocol/response/codex.ts` — Codex JSON → canonical events + SSE frame processor
 *   - `protocol/primitives.ts`     — tool-id encoding, Harmony escaping, ASCII JSON
 *   - `headers.ts`  — Codex identity headers + client/turn metadata
 *   - `errors.ts`   upstream HTTP error → `GatewayError`
 *   - `identity.ts` — Codex account / install / residency lookups
 *
 * Bespoke by wire protocol (Phase C5): session/SSE protocol (Codex Responses
 * envelope, session headers, frame processor) is outside the
 * OpenAI-compatible factory's reach — stays bespoke, never re-audit.
 */
import type { CanonicalEvent, CanonicalRequest } from "../../../transport/canonical-model";
import { GatewayError, capabilityUnsupported } from "../../../transport/gateway-error";
import { getCodexVersion } from "../../operations/client-versions";
import { randomUUID } from "node:crypto";
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import { decodeSseEvents } from "../../../transport/streaming";

import { joinUrl } from "../../../protocol/primitives";
import { postUpstreamJson } from "../../../protocol/transport/openai";
import type {
  ProviderDispatchTarget,
  ProviderAdapter,
  ProviderDispatchContext,
  ResolvedCredential,
} from "../../provider-registry";
import {
  createCodexIdentity,
  getCodexInstallId,
  getCodexResidency,
} from "./codex-identity";
import { mapCodexErrorResponse } from "./codex-errors";
import { canonicalToCodexResponsesPayload } from "../../../protocol/request/codex";
import {
  CodexStreamFrameProcessor,
  parseCodexResponsesJsonToEvents,
} from "../../../protocol/response/codex";
import {
  buildCodexIdentityHeaders,
  createCodexRequestMetadata,
} from "./codex-headers";
import type { CodexSessionState } from "../../../protocol/primitives";
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

/**
 * Codex static model catalog.
 *
 * Kept separate from the Codex adapter so the adapter's protocol graph
 * (`protocol/request/codex`, `protocol/response/codex`, identity headers) is
 * not evaluated merely to materialize the startup model catalog.
 */

function codexResponsesModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
): ModelDefinition {
  return defineModel({
    id: modelId,
    wireFamily: "responses",
    endpoint: "/backend-api/codex/responses",
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning: true,
    toolCall: true,});
}

export const CODEX_MODELS: readonly ModelDefinition[] = [
  // The 6-generation is served in a 272k *default* window that extends to
  // 922k, not a hard 272k cap. Measured against the live registry
  // (`/backend-api/codex/models`): `gpt-6-astra` reports `context_window`
  // 272000 and `max_context_window` 872000, and OpenAI documents 1.05M total
  // context for the generation — 922k input plus the 128k output ceiling — so
  // 922k is the input capacity and the registry's 872k is the stale figure.
  // Recording 272k here published a window less than a third of what the model
  // accepts and made the routing alias rows understate it too.
  //
  // The 5.6 generation keeps the full 1M it was given when OpenAI raised it;
  // the same registry still reports the pre-raise 272k for those ids.
  codexResponsesModel("gpt-6-astra", 922_000, 128_000),
  codexResponsesModel("gpt-6-luna", 922_000, 128_000),
  codexResponsesModel("gpt-6-sol", 922_000, 128_000),
  // 6.1-sol rides the same 6-generation 922k input / 128k output window as
  // gpt-6-sol (1.05M total). Daybreak was retired from the live registry.
  codexResponsesModel("gpt-6.1-sol", 922_000, 128_000),
  codexResponsesModel("gpt-5.6-sol", 1_000_000, 128_000),
  codexResponsesModel("gpt-5.6-terra", 1_000_000, 128_000),
  codexResponsesModel("gpt-5.6-luna", 1_000_000, 128_000),
  codexResponsesModel("gpt-5.5", 272_000, 128_000),
];


/** OAuth-family credential kinds accepted by the Codex adapter. */
export const CODEX_OAUTH_FAMILY_KINDS: readonly string[] = [
  "oauth",
  "scoped_access_token",
  "workload_identity",
];

/**
 * Enforces the OAuth-family credential contract at every Codex dispatch
 * boundary. Rejecting non-OAuth kinds here keeps routing, billing, and
 * upstream host selection single-valued and prevents the `codex` provider
 * ID from silently fanning API-key traffic to the ChatGPT backend.
 */
export function assertCodexOAuthCredential(
  credential: ResolvedCredential,
): void {
  if (
    !(CODEX_OAUTH_FAMILY_KINDS as readonly string[]).includes(
      credential.credential_kind,
    )
  ) {
    throw new GatewayError(
      "invalid_request",
      400,
      `codex: ChatGPT OAuth credential required (got credential_kind=${credential.credential_kind})`,
    );
  }
}

interface CodexAdapterConfig {
  readonly provider_id: "codex";
  /** ChatGPT backend base URL override (defaults to https://chatgpt.com). */
  readonly chatgpt_base_url?: string;
  /** Injected fetch for tests; defaults to global. */
  readonly fetch?: typeof fetch;
  /** Version stamped into User-Agent, e.g. "0.153.0". */
  readonly codex_cli_version?: string;
  /** Attestation token to emit as x-oai-attestation when required. */
  readonly attestation?: string;
  /**
   * Responses Lite transport marker. When true, the adapter applies the
   * Responses Lite body shape and emits the sibling
   * `x-openai-internal-codex-responses-lite` header. Callers / candidate
   * resolution must set this for lite-only models; defaults to false.
   */
  readonly responses_lite?: boolean;
  /**
   * When true, sends `x-codex-beta-features: remote_compaction_v2`.
   * Defaults to false — only set when the backend explicitly requires it.
   */
  readonly enable_remote_compaction_v2?: boolean;
  /**
   * Opt-in concurrent reasoning-summary delivery. When true and a reasoning
   * summary was requested, sends
   * `stream_options.reasoning_summary_delivery: "sequential_cutoff"`.
   * Defaults to false — codex-rs ships the mode under development because it
   * can cancel summary sections still in flight.
   */
  readonly concurrent_reasoning_summaries?: boolean;
  /**
   * Sub-agent context marker. When set, sends `x-openai-subagent`. No
   * automatic trigger in Cartethyia's CanonicalRequest/ProviderDispatchTarget today —
   * wiring is a no-op stub that only emits when explicitly set.
   */
  readonly subagent?: string;
  /**
   * Override for installation ID in tests. Bypasses file-based
   * `getCodexInstallId()`. Ignored in production paths that want the
   * on-disk value.
   */
  readonly installation_id_override?: string;
}

/** Native, non-streaming ChatGPT Responses compaction transport. */
export interface CodexCompactAdapter extends ProviderAdapter {
  compact(
    body: Record<string, unknown>,
    context: ProviderDispatchContext,
  ): Promise<Response>;
}

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com";

function authHeadersForCodex(
  credential: ResolvedCredential,
): Record<string, string> {
  if (!credential.secret || credential.secret.length === 0) {
    throw new GatewayError(
      "invalid_request",
      400,
      "codex: OAuth credential is missing a bearer token",
    );
  }
  const token = new TextDecoder().decode(credential.secret);
  return { authorization: `Bearer ${token}` };
}

/** Reads just enough of an untyped body to tell SSE from JSON, then replays it. */
async function sniffSseBody(body: ReadableStream<Uint8Array> | null): Promise<{
  readonly sse: boolean;
  readonly body: ReadableStream<Uint8Array> | null;
}> {
  if (body === null) return { sse: false, body };
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done || first.value.byteLength === 0) return { sse: false, body: null };
  const head = new TextDecoder().decode(first.value.subarray(0, 32)).trimStart();
  const sse = head.startsWith("event:") || head.startsWith("data:") || head.startsWith(":");
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { sse, body: replay };
}


export function createCodexAdapter(
  config: CodexAdapterConfig,
): CodexCompactAdapter {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const chatgptBase = config.chatgpt_base_url ?? DEFAULT_CHATGPT_BASE_URL;
  const version = (): string => config.codex_cli_version ?? getCodexVersion();
  const attestation = config.attestation;
  const responsesLite = config.responses_lite ?? false;
  const betaRemoteCompaction = config.enable_remote_compaction_v2 ?? false;
  const concurrentReasoningSummaries =
    config.concurrent_reasoning_summaries ?? false;
  const subAgent = config.subagent;
  const installationOverride = config.installation_id_override;

  // Per-session state for sticky routing (x-codex-turn-state / x-models-etag)
  // and identity reuse. Bounded LRU + TTL: an unbounded map would leak
  // memory forever under a long-running process serving many distinct
  // Codex sessions.
  const sessionStates = new Map<
    string,
    { state: CodexSessionState; lastAccessMs: number }
  >();
  const MAX_SESSION_STATES = 2000;
  const SESSION_STATE_TTL_MS = 60 * 60 * 1000;

  function pruneExpiredSessionStates(): void {
    const cutoff = Date.now() - SESSION_STATE_TTL_MS;
    for (const [id, entry] of sessionStates) {
      if (entry.lastAccessMs < cutoff) sessionStates.delete(id);
    }
  }

  function getSessionState(id: string): CodexSessionState | undefined {
    const entry = sessionStates.get(id);
    if (entry === undefined) return undefined;
    if (entry.lastAccessMs < Date.now() - SESSION_STATE_TTL_MS) {
      sessionStates.delete(id);
      return undefined;
    }
    // Refresh recency: delete+set moves the entry to the end (Map preserves
    // insertion order), making eviction below a true least-recently-used sweep.
    sessionStates.delete(id);
    entry.lastAccessMs = Date.now();
    sessionStates.set(id, entry);
    return entry.state;
  }

  function setSessionState(id: string, state: CodexSessionState): void {
    pruneExpiredSessionStates();
    sessionStates.delete(id);
    sessionStates.set(id, { state, lastAccessMs: Date.now() });
    while (sessionStates.size > MAX_SESSION_STATES) {
      const oldest = sessionStates.keys().next();
      if (oldest.done) break;
      sessionStates.delete(oldest.value);
    }
  }

  let cachedInstallationId: string | undefined = installationOverride;
  let installationIdPromise: Promise<string> | undefined;

  async function getInstallationIdCached(): Promise<string> {
    if (cachedInstallationId !== undefined && cachedInstallationId.length > 0)
      return cachedInstallationId;
    if (installationIdPromise !== undefined) return installationIdPromise;
    installationIdPromise = (async () => {
      if (
        installationOverride !== undefined &&
        installationOverride.length > 0
      ) {
        cachedInstallationId = installationOverride;
        return installationOverride;
      }
      try {
        const id = await getCodexInstallId();
        cachedInstallationId = id;
        return id;
      } catch {
        const fallback = randomUUID();
        cachedInstallationId = fallback;
        return fallback;
      }
    })();
    const id = await installationIdPromise;
    installationIdPromise = undefined;
    return id;
  }

  function captureSessionHeadersFromResponse(
    sessionId: string | undefined,
    headers: Headers | Record<string, string> | null | undefined,
  ): void {
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      headers === null ||
      headers === undefined
    )
      return;
    const state = getSessionState(sessionId);
    if (state === undefined) return;
    let turnState: string | null = null;
    let modelsEtag: string | null = null;
    if (headers instanceof Headers) {
      turnState = headers.get("x-codex-turn-state");
      modelsEtag = headers.get("x-models-etag");
    } else if (typeof headers === "object") {
      const rec = headers as Record<string, string>;
      for (const [k, v] of Object.entries(rec)) {
        const lower = k.toLowerCase();
        if (lower === "x-codex-turn-state") turnState = v;
        if (lower === "x-models-etag") modelsEtag = v;
      }
    }
    if (
      turnState !== null &&
      turnState.length > 0 &&
      (state.turnState === undefined || state.turnState.length === 0)
    ) {
      state.turnState = turnState;
    }
    if (modelsEtag !== null && modelsEtag.length > 0) {
      state.modelsEtag = modelsEtag;
    }
  }

  return {
    provider_id: "codex" as const,
    async compact(
      body: Record<string, unknown>,
      context: ProviderDispatchContext,
    ): Promise<Response> {
      assertCodexOAuthCredential(context.credential);
      const installationId = await getInstallationIdCached();
      const identity = createCodexIdentity();
      const token =
        context.credential.secret === undefined
          ? undefined
          : new TextDecoder().decode(context.credential.secret);
      const residency =
        token === undefined
          ? undefined
          : getCodexResidency({ accessToken: token });
      const { turnMetadataJson } = createCodexRequestMetadata({
        installationId,
        sessionId: identity.session_id,
        threadId: identity.thread_id,
        windowId: identity.window_id,
        turnId: identity.turn_id,
        requestKind: "compaction",
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeadersForCodex(context.credential),
        ...buildCodexIdentityHeaders({
          credential: context.credential,
          version: version(),
          attestation,
          residency,
          sessionId: identity.session_id,
          threadId: identity.thread_id,
          windowId: identity.window_id,
          turnId: identity.turn_id,
          installationId,
          turnMetadataJson,
          betaFeatures: betaRemoteCompaction
            ? "remote_compaction_v2"
            : undefined,
          routingHint: `model=${body["model"] as string}`,
        }),
      };
      const { res, release } = await postUpstreamJson(
        "https://chatgpt.com/backend-api/codex/responses/compact",
        headers,
        body,
        context,
        context.outbound_fetch ?? fetchFn,
      );
      try {
        if (!res.ok) await mapCodexErrorResponse(res);
        const responseBody = await res.json();
        return Response.json(responseBody, {
          status: res.status,
          headers: { "cache-control": "no-store" },
        });
      } finally {
        release();
      }
    },
    async *dispatch(
      request: CanonicalRequest,
      candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): AsyncIterable<CanonicalEvent> {
      if (candidate.provider_id !== "codex") {
        throw new GatewayError(
          "invalid_request",
          400,
          "codex adapter received non-codex candidate",
        );
      }
      if (candidate.wire_family !== "responses") {
        throw capabilityUnsupported("responses", {
          wire_family: candidate.wire_family,
        });
      }
      if (request.model.includes("?")) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model must not contain query string",
        );
      }

      assertCodexOAuthCredential(context.credential);

      const endpointPath =
        candidate.endpoint_path.length > 0
          ? candidate.endpoint_path
          : "/backend-api/codex/responses";
      const url = joinUrl(chatgptBase, endpointPath);

      const nonEmpty = (value: string | undefined): string | undefined =>
        value === undefined || value.length === 0 ? undefined : value;
      let rawSessionId = nonEmpty(request.session_id) ?? resolvePromptCacheKey(request, context);
      let rawThreadId = nonEmpty(request.thread_id);
      let rawWindowId = nonEmpty(request.window_id);
      let rawTurnId = nonEmpty(request.turn_id);
      const rawParentTurnId = nonEmpty(request.parent_turn_id);
      const rawConversationId = nonEmpty(request.conversation_id);

      const installationId = await getInstallationIdCached();

      // Ensure a session state entry for this session so subsequent turns
      // can carry sticky routing headers.
      let effectiveSessionId: string;
      let sessionState: CodexSessionState;
      if (rawSessionId !== undefined && rawSessionId.length > 0) {
        effectiveSessionId = rawSessionId;
        const existing = getSessionState(effectiveSessionId);
        if (existing !== undefined) {
          sessionState = existing;
          if (rawThreadId !== undefined && rawThreadId.length > 0)
            sessionState.threadId = rawThreadId;
          if (rawWindowId !== undefined && rawWindowId.length > 0)
            sessionState.windowId = rawWindowId;
        } else {
          const threadId = rawThreadId ?? randomUUID();
          const windowId = rawWindowId ?? randomUUID();
          sessionState = {
            sessionId: effectiveSessionId,
            threadId,
            windowId,
          };
          setSessionState(effectiveSessionId, sessionState);
        }
      } else {
        // Missing session identity receives a fresh request-local identity so
        // every request has a complete client-metadata envelope.
        const identity = createCodexIdentity();
        effectiveSessionId = identity.session_id;
        rawSessionId = effectiveSessionId;
        rawThreadId = rawThreadId ?? identity.thread_id;
        rawWindowId = rawWindowId ?? identity.window_id;
        rawTurnId = rawTurnId ?? identity.turn_id;
        sessionState = {
          sessionId: effectiveSessionId,
          threadId: rawThreadId,
          windowId: rawWindowId,
        };
        setSessionState(effectiveSessionId, sessionState);
      }
      const threadId = rawThreadId ?? sessionState.threadId;
      const windowId = rawWindowId ?? sessionState.windowId;
      const turnId = rawTurnId ?? randomUUID();
      sessionState.threadId = threadId;
      sessionState.windowId = windowId;
      const turnStartedAtUnixMs = Date.now();
      sessionState.turnStartedAtUnixMs = turnStartedAtUnixMs;

      // If conversation_id not supplied, mirror session_id (reference behavior).
      const conversationId = rawConversationId ?? effectiveSessionId;

      const token =
        context.credential.secret === undefined
          ? undefined
          : new TextDecoder().decode(context.credential.secret);
      const residency =
        nonEmpty(request.residency) ??
        (token === undefined
          ? undefined
          : getCodexResidency({ accessToken: token }));

      const { clientMetadata, turnMetadataJson } =
        createCodexRequestMetadata({
          installationId,
          sessionId: effectiveSessionId,
          threadId,
          windowId,
          turnId,
          ...(rawParentTurnId === undefined
            ? {}
            : { parentTurnId: rawParentTurnId }),
          turnStartedAtUnixMs,
        });
      const betaFeatures = betaRemoteCompaction
        ? "remote_compaction_v2"
        : undefined;
      // `x-codex-routing-hint` mirrors codex-rs (`codexRoutingHint`): the
      // Codex adapter is OAuth-family only, so the hint is always emitted.
      const serviceTier = request.generation_controls.service_tier;
      const routingHint = serviceTier
        ? `model=${request.model};tier=${serviceTier}`
        : `model=${request.model}`;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
      };
      Object.assign(headers, authHeadersForCodex(context.credential));
      Object.assign(
        headers,
        buildCodexIdentityHeaders({
          credential: context.credential,
          version: version(),
          attestation,
          residency,
          sessionId: effectiveSessionId,
          threadId,
          windowId,
          turnId,
          ...(rawParentTurnId === undefined
            ? {}
            : { parentTurnId: rawParentTurnId }),
          conversationId,
          installationId,
          turnMetadataJson,
          betaFeatures,
          subAgent,
          responsesLite,
          turnState: sessionState.turnState,
          modelsEtag: sessionState.modelsEtag,
          routingHint,
        }),
      );
      const outboundFetch = context.outbound_fetch ?? fetchFn;
      const payload = canonicalToCodexResponsesPayload(request, {
        responsesLite,
        concurrentReasoningSummaries,
      });
      // Codex prompt caching is routed by a stable per-session key. The
      // official client sends this key on every Responses request; relying on
      // an optional inbound cache hint leaves Model Lab sessions uncached.
      payload["prompt_cache_key"] = effectiveSessionId;
      payload["client_metadata"] = clientMetadata;

      const { res, release } = await postUpstreamJson(
        url,
        headers,
        payload,
        context,
        outboundFetch,
      );
      try {
      if (!res.ok) {
        await mapCodexErrorResponse(res);
      }

      captureSessionHeadersFromResponse(effectiveSessionId, res.headers);

      const contentType = res.headers.get("content-type") ?? "";
      // ChatGPT Codex omits content-type and always speaks SSE, including
      // when the client asked for JSON. Reading the whole clone to sniff the
      // type waits for the upstream to finish. Peek only the first frame.
      const typedSse = contentType.toLowerCase().includes("text/event-stream");
      const sniffed = typedSse || request.stream === true ? undefined : await sniffSseBody(res.body);
      const body = sniffed?.body ?? res.body;
      const isSse = typedSse || request.stream === true || sniffed?.sse === true;
      if (isSse) {
        const processor = new CodexStreamFrameProcessor(2);
        const respId = `codex_${Date.now()}`;
        yield {
          type: "response_start",
          sequence_number: 1,
          event_id: respId,
          model: request.model,
        } as CanonicalEvent;
        for await (const sse of decodeSseEvents(body, {
          signal: context.abort_signal,
        })) {
          const data = sse.data.trim();
          // [DONE] ends the stream: break without waiting for TCP close so
          // gated upstreams (close depends on our terminal) cannot deadlock.
          if (data === "[DONE]") break;
          if (data.length === 0) continue;
          try {
            const json = JSON.parse(data) as Record<string, unknown>;
            if (
              json["type"] === "response.metadata" &&
              typeof json["headers"] === "object"
            ) {
              captureSessionHeadersFromResponse(
                effectiveSessionId,
                json["headers"] as Record<string, string>,
              );
            }
            for (const ev of processor.process(json)) yield ev;
          } catch (error: unknown) {
            // A typed upstream error is already classified — rethrow it so its
            // code (quota, overload, context length) survives instead of being
            // rewritten as a malformed-SSE failure.
            if (error instanceof GatewayError) throw error;
            // A corrupt line is a corrupt stream, not a short success:
            // fail exactly like the chat/responses decoders (502) instead
            // of silently decoding truncated output as complete.
            throw new GatewayError(
              "platform_unavailable",
              502,
              error instanceof Error
                ? `Malformed SSE event: ${error.message}`
                : "Malformed SSE event",
              {},
              "upstream",
            );
          }
        }
        yield processor.terminalEvent();
      } else {
        const json = JSON.parse(await new Response(body).text()) as Record<string, unknown>;
        if (typeof json["headers"] === "object" && json["headers"] !== null) {
          captureSessionHeadersFromResponse(
            effectiveSessionId,
            json["headers"] as Record<string, string>,
          );
        }
        const events = parseCodexResponsesJsonToEvents(json, request);
        for (const ev of events) yield ev;
      }
      } finally {
        release();
      }
    },
  };
}
