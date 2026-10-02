/**
 * The native web-search route (`POST /v1/search`) and the dependency surface it
 * needs to drive `runAttemptLoop`.
 *
 * A search request is not chat-shaped: the caller sends `{model, query,
 * max_results, …}` and receives a normalized list of hits. Routing, admission,
 * retry, accounting, and telemetry still run through the shared attempt loop —
 * the caller's `model` resolves through the same routing engine (so aliases and
 * combos of search providers work), and failover to a sibling search provider
 * is the same policy as any other route.
 *
 * The adapter owns the per-provider request mapping and response normalization
 * (`ProviderAdapter.websearch`), so this handler never learns a provider's wire;
 * it only validates the trust boundary, drives the loop, and serializes the
 * normalized envelope.
 */
import type { ProviderAdapter, ProviderDispatchTarget } from "../../providers/provider-registry";
import { GatewayError } from "../gateway-error";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { OAuthTokenRefresher, OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { RouteSnapshotService } from "../routing/route-model";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { ProxyRequestStateStore } from "../request/state";
import { ProxyRequestPreparer } from "../request/preparer";
import { isModelAllowed } from "../../security/api-key-auth";
import { parseThinkingSuffix } from "../translation/thinking";
import { completeAttempt, estimatedUsage } from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";

export interface WebsearchHandlerDeps {
  readonly db: CartethyiaDatabase;
  readonly providerAdapters: ReadonlyMap<string, ProviderAdapter>;
  readonly resolveProviderAdapter?: (providerId: string) => Promise<ProviderAdapter | undefined>;
  readonly proxyPreparer: ProxyRequestPreparer;
  readonly stateStore: ProxyRequestStateStore;
  readonly poolSelector?: NetworkPoolSelector;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

/** Adapter that can serve a web-search request. */
type WebsearchAdapter = ProviderAdapter & {
  websearch: NonNullable<ProviderAdapter["websearch"]>;
};

function jsonResponse(payload: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}

export function createWebsearchHandler(deps: WebsearchHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const body = state.ingressBody;
    if (!authorization || body === null || typeof body !== "object" || Array.isArray(body))
      throw new GatewayError("invalid_request", 400, "search request body must be a JSON object");
    const search = body as Record<string, unknown>;
    if (typeof search.model !== "string" || search.model.trim().length === 0)
      throw new GatewayError("invalid_request", 400, "model is required");
    // The search "model" names the provider (or an alias/combo of one). A
    // thinking suffix is stripped for the same reason the canonical preparer
    // strips it: it is not part of any registered id.
    const { model: bareModel } = parseThinkingSuffix(search.model);
    const searchBody: Record<string, unknown> =
      bareModel === search.model ? search : { ...search, model: bareModel };
    if (!isModelAllowed(authorization.snapshot, bareModel))
      throw new GatewayError("model_not_found", 404, "model is not allowed for this API key");
    // Trust boundary only: the query must be a non-empty string. The adapter
    // validates the remaining shape when it maps the body onto its provider.
    if (typeof search.query !== "string" || search.query.trim().length === 0)
      throw new GatewayError("invalid_request", 400, "query is required");

    const prepared = await deps.proxyPreparer.prepareNativeService({
      model: bareModel,
      serviceKind: "websearch",
      authorization,
      ...(state.abortController.signal ? { signal: state.abortController.signal } : {}),
    });
    return runAttemptLoop<Response, WebsearchAdapter>({
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
      candidates: prepared.candidates,
      tenantId: prepared.authorization.tenantId,
      strictPoolSelection: false,
      exhaustedError: new GatewayError("admission_unavailable", 503, "no eligible search route"),
      prepare: async (candidate) => {
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
              provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
              credential_kind: "none" as const,
            };
        const adapter = (deps.resolveProviderAdapter
          ? await deps.resolveProviderAdapter(candidate.provider_id)
          : deps.providerAdapters.get(candidate.provider_id)) as WebsearchAdapter | undefined;
        if (!adapter || typeof adapter.websearch !== "function")
          throw new GatewayError(
            "capability_unsupported",
            400,
            "web search is unavailable for this provider",
          );
        return { credential, adapter };
      },
      attempt: async (context) => {
        const { candidate, credential, leases, providerCapture } = context;
        const target: ProviderDispatchTarget = {
          provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
          model_id: candidate.model_id,
          wire_family: candidate.wire_family,
          endpoint_path: candidate.endpoint,
          capabilities: candidate.capability_profile,
        };
        const upstreamBody =
          searchBody.model === candidate.model_id
            ? searchBody
            : { ...searchBody, model: candidate.model_id };
        const outcome = await context.adapter.websearch(upstreamBody, target, {
          credential,
          deadline: state.deadlineMs,
          abort_signal: state.abortController.signal,
          ...(candidate.user_agent === undefined ? {} : { user_agent: candidate.user_agent }),
          ...(deps.networkBindingFactory
            ? {
                outbound_fetch: deps.networkBindingFactory.fetch(
                  leases.proxySlot?.poolId,
                  authorization.tenantId,
                ),
              }
            : {}),
        });
        const payload = {
          provider: candidate.provider_id,
          model: candidate.model_id,
          query: typeof upstreamBody.query === "string" ? upstreamBody.query : "",
          results: outcome.results,
          total_results: outcome.total_results ?? outcome.results.length,
          usage: { queries_used: 1 },
        };
        // Search consumes no model tokens; commit a zero-token usage so the
        // attempt is accounted and telemetry emits exactly once.
        const usage = estimatedUsage(0, 0);
        await completeAttempt(state, {
          status: "completed",
          providerId: candidate.provider_id,
          ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
          ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
          ...(leases.proxySlot ? { networkPoolId: leases.proxySlot.poolId } : {}),
          usage,
          modelId: candidate.model_id,
          lease: leases.lease,
          commitUsage: usage,
          terminal: true,
          tenantId: prepared.authorization.tenantId,
          ingressBody: state.ingressBody,
          responseBody: payload,
          providerCapture,
          db: deps.db,
          ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
          ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
        });
        metrics.proxy_requests_total.inc(1, { status: "completed" });
        return jsonResponse(payload, 200, state.requestId);
      },
    });
  };
}
