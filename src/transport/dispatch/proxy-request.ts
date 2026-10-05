import { isBundledProviderId } from "../../providers/provider-registry";
import type { ProviderDispatchContext, ProviderId, ProviderAdapter } from "../../providers/provider-registry";
import { GatewayError } from "../gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../canonical-model";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { OAuthTokenRefresher } from "../../providers/authentication/oauth-refresh-service";
import type { OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { RouteSnapshotService } from "../routing/route-model";
import { chatAdapter } from "../surface/chat/adapter";
import { responsesAdapter } from "../surface/responses/adapter";
import { messagesAdapter } from "../surface/messages/adapter";
import { completionAdapter } from "../surface/completion";
import { forwardedRequestHeaders, proxySuccessHeaders, buildUpstreamDispatchContext } from "./upstream";
import { resolvePromptCacheKey } from "../../providers/operations/session-resolution";
import { applyTenantPreferences } from "./tenant-preferences";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { ProxyRequestStateStore } from "../request/state";
import type { ProxyRequestState } from "../request/state";
import type { ProxyRequestPreparer } from "../request/preparer";
import { repriceUsage } from "../../providers/usage";
import {
  captureProviderExchange,
  completeAttempt,
  completionContext,
  estimatedUsage,
  parseCapturedBody,
  terminalFailure,
} from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";
import { dispatchFusionRequest } from "./fusion-dispatch";
import { projectForRoute, routeCapabilitiesFor } from "../translation/capabilities";
import { dispatchStreamingAttempt } from "./streaming-attempt";

export interface ProviderProxyHandlerDeps {
  readonly db: CartethyiaDatabase;
  readonly providerAdapters: ReadonlyMap<string, ProviderAdapter>;
  /** Preferred over `providerAdapters`: resolves an adapter on demand and caches it. */
  readonly resolveProviderAdapter?: (providerId: string) => Promise<ProviderAdapter | undefined>;
  readonly stateStore: ProxyRequestStateStore;
  /** Used by the fusion branch to plan and dispatch each panel/judge model. */
  readonly proxyPreparer?: ProxyRequestPreparer;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  /** Live lookup of a provider's SSRF-validated upstream host. */
  readonly byokUpstreamHosts?: { readonly get: (providerId: string) => ByokUpstreamHost | undefined };
  readonly poolSelector?: NetworkPoolSelector;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

/**
 * First-token latency for one attempt, in the spread shape `completeAttempt`
 * takes: `{}` when there is nothing to measure — no first byte arrived (a
 * pre-stream failure) or the attempt never started upstream — and
 * `{ ttfbMs }` otherwise. A stream reports whichever of the first byte or the
 * first content delta landed first; a non-streaming call has only the delta.
 */
function ttfbFields(
  firstByteAt: number | undefined,
  firstContentDeltaAtMs: number | undefined,
  startedAtMs: number | undefined,
): { ttfbMs?: number } {
  const firstAt = firstByteAt ?? firstContentDeltaAtMs;
  if (firstAt === undefined || startedAtMs === undefined) return {};
  return { ttfbMs: Math.max(0, firstAt - startedAtMs) };
}

/**
 * Encodes a completed canonical event list onto the client's own surface and
 * returns the wire `Response`. Used by the fusion branch, whose final answer is
 * produced by a nested dispatch rather than by the attempt loop; the surface
 * mapping is identical to the attempt loop's own non-streaming encode, so the
 * two cannot drift. Fusion always answers non-streaming (the panel/judge
 * synthesis is a single completed answer), so only the JSON encoders are used.
 */
function encodeCanonicalResponse(
  canonicalRequest: CanonicalRequest,
  events: readonly CanonicalEvent[],
  state: ProxyRequestState,
): Response {
  const options = {
    created: Date.now() / 1000,
    include_usage: canonicalRequest.generation_controls["extension:include_usage"] === true,
  };
  const output =
    canonicalRequest.source_surface === "chat"
      ? chatAdapter.encode([...events], options)
      : canonicalRequest.source_surface === "responses"
        ? responsesAdapter.encodeOutput([...events], { ...options, model: canonicalRequest.model })
        : canonicalRequest.source_surface === "messages"
          ? messagesAdapter.encodeOutput([...events], options as never)
          : completionAdapter.encodeOutput([...events], {
              ...options,
              prompt: canonicalRequest.generation_controls["extension:completion.prompt"],
              echo: canonicalRequest.generation_controls["extension:completion.echo"] === true,
              suffix: canonicalRequest.generation_controls["extension:completion.suffix"],
            });
  return new Response(output.bytes as unknown as BodyInit, {
    headers: { "content-type": output.content_type, ...proxySuccessHeaders(state) },
  });
}

/**
 * The proxy request hot path: dispatches one prepared, admitted request to
 * the best eligible provider candidate, with bounded failover.
 *
 * Lifecycle per request (state prepared earlier by the request planner):
 * tenant thinking/reasoning preferences are applied to the canonical request,
 * then `runAttemptLoop` walks the ordered candidate list. Each attempt:
 *
 * 1. **Prepare** — resolves the account credential (refreshing OAuth tokens
 *    through `oauthRefreshService` when needed) and the provider adapter;
 *    BYOK providers additionally require a validated network binding.
 * 2. **Lease** — `dispatch/leases` atomically takes the admission lease
 *    (RPM/token/concurrency), routing reservation, and network-pool slot;
 *    released in `finally` unless retained by a streaming response.
 * 3. **Dispatch** — the adapter call goes through the validated network
 *    binding (direct or pool-bound fetch) with per-attempt exchange capture;
 *    capability/quirk incompatibilities degrade via a bounded compatibility
 *    fallback plan before re-dispatching.
 * 4. **Settle** — `completeAttempt` commits usage, updates account health,
 *    finalizes telemetry; `dispatch/attempt-finalize` owns terminal bookkeeping.
 *
 * Error handling: a failed *intermediate* attempt is retried on the next
 * candidate after a bounded backoff (`failure-policy`); non-retryable
 * failures and exhaustion of the candidate list propagate as GatewayErrors.
 * Streaming responses prime the first upstream event before the 200 is
 * committed (so failover can still happen), then retain their leases until
 * stream completion/cancel via `releaseStreamResources`.
 */
export async function handleProviderProxyRequest(
  request: Request,
  deps: ProviderProxyHandlerDeps,
): Promise<Response> {
  const state = deps.stateStore.require(request);
  const prepared = state.preparedRequest;
  if (!prepared)
    throw new GatewayError("admission_unavailable", 503, "proxy request context unavailable");
  const canonicalRequest = await applyTenantPreferences(prepared, deps.db);
  const candidates =
    prepared.eligibleRouteCandidates.length > 0 ? prepared.eligibleRouteCandidates : [prepared.candidate];
  // Inbound headers are safe to re-read (only bodies are single-read).
  // Allowlisted once per request, forwarded to every candidate attempt.
  const inboundHeaders = forwardedRequestHeaders(request);
  // Stable per-conversation affinity for every attempt on every wire: caller
  // key first, then inbound session headers, then a hash of the opening turn.
  // The stub carries only the fields the resolver reads (request_headers).
  const conversationAffinity = resolvePromptCacheKey(canonicalRequest, {
    request_headers: inboundHeaders,
  } as ProviderDispatchContext);
  // A `fusion` combo runs its members as a panel and a judge, not as a single
  // failover chain, so it takes its own path. Everything else — aliases, plain
  // combos, single models — falls through to the attempt loop below. Without a
  // preparer the fusion branch cannot plan its members, so it fails closed
  // rather than silently running a fusion combo as a plain failover chain.
  if (prepared.plan.fusion) {
    if (!deps.proxyPreparer)
      throw new GatewayError(
        "admission_unavailable",
        503,
        "fusion routing is unavailable: no request preparer configured",
      );
    return dispatchFusionRequest({
      state,
      deps: {
        db: deps.db,
        providerAdapters: deps.providerAdapters,
        ...(deps.resolveProviderAdapter ? { resolveProviderAdapter: deps.resolveProviderAdapter } : {}),
        proxyPreparer: deps.proxyPreparer,
        ...(deps.networkBindingFactory ? { networkBindingFactory: deps.networkBindingFactory } : {}),
        ...(deps.poolSelector ? { poolSelector: deps.poolSelector } : {}),
        ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
        ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
        ...(deps.resolveOAuthRefresher ? { resolveOAuthRefresher: deps.resolveOAuthRefresher } : {}),
        ...(deps.oauthRefreshService ? { oauthRefreshService: deps.oauthRefreshService } : {}),
      },
      prepared,
      canonicalRequest,
      inboundHeaders,
      fusion: prepared.plan.fusion,
    }).then(({ events }) => encodeCanonicalResponse(canonicalRequest, events, state));
  }
  return runAttemptLoop<Response, ProviderAdapter>({
    state,
    deps,
    leaseSource: {
      admissionService: prepared.admissionService,
      routingEngine: prepared.routingEngine,
      plan: prepared.plan,
      estimatedInputTokens: prepared.estimatedInputTokens,
      estimatedOutputTokens: prepared.estimatedOutputTokens,
      authorizationSnapshot: prepared.authorization.snapshot,
    },
    candidates,
    tenantId: prepared.authorization.tenantId,
    strictPoolSelection: true,
    resolveHost: (candidate) => deps.byokUpstreamHosts?.get(candidate.provider_id),
    exhaustedError: new GatewayError("admission_unavailable", 503, "no eligible route"),
    prepare: async (candidate) => {
      if (!candidate.provider_account_id && candidate.requires_account !== false)
        throw new GatewayError(
          "admission_unavailable",
          503,
          "no upstream credential configured for this route",
        );
      const credential = candidate.provider_account_id
        ? await resolveCredentialForAccount(
            deps.db,
            candidate.provider_id,
            candidate.provider_account_id,
            deps.oauthRefreshService && deps.resolveOAuthRefresher
              ? { refreshService: deps.oauthRefreshService, resolveRefresher: deps.resolveOAuthRefresher }
              : undefined,
          )
        : {
            provider_id: candidate.provider_id as ProviderId,
            credential_kind: "none" as const,
          };
      const adapter = deps.resolveProviderAdapter
        ? await deps.resolveProviderAdapter(candidate.provider_id)
        : deps.providerAdapters.get(candidate.provider_id);
      if (!adapter)
        throw new GatewayError("admission_unavailable", 503, "provider adapter not registered");
      if (!isBundledProviderId(candidate.provider_id)) {
        if (!deps.byokUpstreamHosts?.get(candidate.provider_id) || !deps.networkBindingFactory)
          throw new GatewayError(
            "admission_unavailable",
            503,
            "validated network binding is required for configurable upstreams",
          );
      }
      return { credential, adapter };
    },
    attempt: async (context) => {
      const { candidate, credential, adapter } = context;
      const networkPoolId = context.leases.networkPoolId;
      const providerCapture = context.providerCapture;
      const lease = context.leases.lease;
      const reservation = context.leases.reservation;
      const proxySlot = context.leases.proxySlot;
      const providerRouteCandidate = {
        provider_id: candidate.provider_id,
        model_id: candidate.model_id,
        wire_family: candidate.wire_family,
        endpoint_path: candidate.endpoint,
        capabilities: candidate.capability_profile,
        user_agent: candidate.user_agent,
      };
      const candidateRequest =
        candidate.model_id === canonicalRequest.model
          ? canonicalRequest
          : { ...canonicalRequest, model: candidate.model_id };
      const dispatchRequest = projectForRoute(
        candidateRequest,
        routeCapabilitiesFor(candidate),
      );
      if (canonicalRequest.stream) {
        return dispatchStreamingAttempt({
          state,
          deps,
          prepared,
          canonicalRequest,
          candidate,
          credential,
          adapter,
          dispatchRequest,
          providerRouteCandidate,
          inboundHeaders,
          conversationAffinity,
          lease,
          reservation,
          proxySlot,
          networkPoolId,
          providerCapture,
          retainLeases: context.retainLeases,
          ttfbFields,
        });
      }
      // Pool slot ownership belongs to the candidate attempt: the slot was
      // acquired atomically with selection above, and `proxySlot` is
      // released in the `finally` below. Acquiring again here (including
      // inside the compatibility-fallback `dispatch` callback, which may run
      // twice) would overwrite `proxySlot` and leak the first handle.
      const dispatchContextBase = buildUpstreamDispatchContext({
        credential,
        deadline: state.deadlineMs,
        signal: state.abortController.signal,
        headers: inboundHeaders,
        requestIdentity: state,
        ...(conversationAffinity ? { conversationAffinity } : {}),
        ...(candidate.user_agent === undefined ? {} : { userAgent: candidate.user_agent }),
        ...(deps.networkBindingFactory
          ? {
              outboundFetch: captureProviderExchange(
                deps.networkBindingFactory.fetch(
                  networkPoolId,
                  prepared.authorization.snapshot.tenant_id,
                ),
                providerCapture,
              ),
            }
          : {}),
        ...(deps.networkBindingFactory
          ? { outboundWebSocket: deps.networkBindingFactory.webSocket(networkPoolId, prepared.authorization.snapshot.tenant_id) }
          : {}),
      });
      const dispatch = async (input: typeof canonicalRequest): Promise<CanonicalEvent[]> => {
        const events: CanonicalEvent[] = [];
        for await (const event of adapter.dispatch(
          input,
          providerRouteCandidate as never,
          dispatchContextBase as never,
        )) {
          // Add timestamp to event for profiling
          const timestampedEvent = { ...event, timestamp: Date.now() };
          events.push(timestampedEvent);
        }
        return events;
      };
      state.upstreamDispatchStartedAtMs = Date.now();
      const events = await dispatch(dispatchRequest);
      // Extract timing from events for non-streaming path
      let firstContentDeltaAtMs: number | undefined;
      for (const event of events) {
        if (event.timestamp && event.type === "content_delta" && firstContentDeltaAtMs === undefined) {
          firstContentDeltaAtMs = event.timestamp;
        }
      }
      
      const terminal = events.find((event) => event.type === "terminal");
      if (terminal === undefined) throw terminalFailure(undefined);
      const terminalError = terminalFailure(terminal);
      if (terminalError !== undefined) throw terminalError;
      const usage =
        terminal.usage ??
        estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens);
      const pricedUsage = repriceUsage(usage, candidate.provider_id, candidate.model_id);
      const options = {
        created: Date.now() / 1000,
        include_usage: canonicalRequest.generation_controls["extension:include_usage"] === true,
      };
      const output =
        canonicalRequest.source_surface === "chat"
          ? chatAdapter.encode(events, options)
          : canonicalRequest.source_surface === "responses"
            ? responsesAdapter.encodeOutput(events, { ...options, model: canonicalRequest.model })
            : canonicalRequest.source_surface === "messages"
              ? messagesAdapter.encodeOutput(events, options as never)
              : completionAdapter.encodeOutput(events, {
                  ...options,
                  prompt: canonicalRequest.generation_controls["extension:completion.prompt"],
                  echo: canonicalRequest.generation_controls["extension:completion.echo"] === true,
                  suffix: canonicalRequest.generation_controls["extension:completion.suffix"],
                });
      await completeAttempt(state, {
        status: "completed",
        ...completionContext({
          providerId: candidate.provider_id,
          modelId: candidate.model_id,
          tenantId: prepared.authorization.tenantId,
          ingressBody: state.ingressBody,
          providerCapture,
          db: deps.db,
          ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
          ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
          ...(networkPoolId ? { networkPoolId } : {}),
          ...(lease ? { lease } : {}),
          ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
          ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
        }),
        ...ttfbFields(undefined, firstContentDeltaAtMs, state.upstreamDispatchStartedAtMs),
        usage: pricedUsage,
        commitUsage: pricedUsage,
        // Decode once: `output.bytes` is a `Uint8Array`, which
        // `parseCapturedBody` returns untouched — the Server panel would store
        // a byte-index map (`{"0":123,…}`) after redaction instead of the
        // response. The client receives the same text we parse here, so both
        // panels stay in sync.
        responseBody: parseCapturedBody(new TextDecoder().decode(output.bytes)),
        // Non-stream: client receives the exact same bytes we just encoded —
        // keep Server and Client panels in sync so the drawer never shows “—”.
        clientResponseText: new TextDecoder().decode(output.bytes),
        ...(firstContentDeltaAtMs !== undefined ? { firstContentDeltaAtMs } : {}),
      });
      metrics.proxy_requests_total.inc(1, { status: "completed" });
      return new Response(output.bytes as unknown as BodyInit, {
        headers: { "content-type": output.content_type, ...proxySuccessHeaders(state) },
      });
    },
  });
}
