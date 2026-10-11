/**
 * `POST /v1/messages/count_tokens`.
 *
 * Anthropic's token counter: the caller sends a Messages-shaped body and gets
 * `{input_tokens}` back, with no generation and no billing. Claude Code calls it
 * before a turn to decide whether the context still fits, so the number has to be
 * the one the provider itself would report — an estimate would move the
 * compaction threshold to the wrong place, and being wrong in either direction is
 * a visible failure: too low and the follow-up request is rejected for length,
 * too high and the client compacts early for no reason.
 *
 * So the count is **forwarded**, never computed. The body is Anthropic's and the
 * answer is Anthropic's, which is also why this does not go through the canonical
 * surface codecs: `CanonicalRequest`/`CanonicalEvent` model a chat turn, and a
 * count is not one.
 *
 * The upstream response is returned **verbatim** — status, headers, and body.
 * Anthropic answers an unusable body with its own error envelope, and the client
 * is entitled to read that error rather than a gateway paraphrase of it.
 *
 * The shape follows `generation.ts`: validate the trust boundary, drive
 * `runAttemptLoop`, hand back what the upstream produced. Candidate eligibility
 * is the provider's wire family, decided in
 * `ProxyRequestPreparer.prepareNativeTokenCount`.
 */
import type { ProviderAdapter, ProviderDispatchTarget } from "../../providers/contracts";
import { GatewayError } from "../../protocol/gateway-error";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { OAuthTokenRefresher, OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProxyRequestStateStore } from "../request/state";
import type { ProxyRequestPreparer } from "../request/preparer";
import { completeAttempt, estimatedUsage } from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";

export interface TokenCountHandlerDeps {
  readonly db: CartethyiaDatabase;
  readonly providerAdapters: ReadonlyMap<string, ProviderAdapter>;
  readonly resolveProviderAdapter?: (providerId: string) => Promise<ProviderAdapter | undefined>;
  readonly proxyPreparer: ProxyRequestPreparer;
  readonly stateStore: ProxyRequestStateStore;
  readonly poolSelector?: NetworkPoolSelector;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly snapshotService?: import("../routing/route-model").RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

/** Builds the `POST /v1/messages/count_tokens` handler. */
export function createTokenCountHandler(deps: TokenCountHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const body = state.ingressBody;
    if (!authorization || body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new GatewayError(
        "invalid_request",
        400,
        "The count_tokens body must be a JSON object, the same shape POST /v1/messages accepts.",
      );
    }
    const countBody = body as Record<string, unknown>;

    // `model` names the route and `messages` is what gets counted; both are the
    // upstream's own required fields, so the gateway does not restate its own
    // narrower rule and risk rejecting a body the provider would accept.
    if (typeof countBody.model !== "string" || countBody.model.trim().length === 0) {
      throw new GatewayError("invalid_request", 400, "A model is required: it names the provider to count with.");
    }
    if (!Array.isArray(countBody.messages)) {
      throw new GatewayError("invalid_request", 400, "messages must be an array — there is nothing to count without it.");
    }
    if (!authorization.snapshot.scopes?.includes("routing:invoke" as never)) {
      throw new GatewayError(
        "invalid_request",
        403,
        "token counting not allowed for this key — enable routing:invoke on the API key",
      );
    }

    const prepared = await deps.proxyPreparer.prepareNativeTokenCount({
      model: countBody.model,
      authorization,
      ...(state.abortController.signal ? { signal: state.abortController.signal } : {}),
      ...(state.clientUserAgent === undefined ? {} : { clientUserAgent: state.clientUserAgent }),
    });

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
      candidates: prepared.candidates,
      tenantId: prepared.authorization.tenantId,
      strictPoolSelection: false,
      exhaustedError: new GatewayError(
        "admission_unavailable",
        503,
        "no eligible route can count tokens for this model",
      ),
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
        const adapter = deps.resolveProviderAdapter
          ? await deps.resolveProviderAdapter(candidate.provider_id)
          : deps.providerAdapters.get(candidate.provider_id);
        if (!adapter) {
          throw new GatewayError("capability_unsupported", 400, "token counting is unavailable for this provider");
        }
        return { credential, adapter };
      },
      attempt: async (context) => {
        const { candidate, credential, leases, providerCapture } = context;
        // Name the model the route actually resolved to: a caller may address it
        // through an alias, and the upstream must count the real model's tokens.
        const upstreamBody =
          countBody.model === candidate.model_id
            ? countBody
            : { ...countBody, model: candidate.model_id };

        const adapter = context.adapter;
        if (typeof adapter.dispatchNativeService !== "function") {
          throw new GatewayError("capability_unsupported", 400, "token counting is unavailable for this provider");
        }

        const target: ProviderDispatchTarget = {
          provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
          model_id: candidate.model_id,
          wire_family: candidate.wire_family,
          // Always supplied. `dispatchNativeService` falls back to
          // `/v1/systemone` on an empty path, which would post a Messages body to
          // a decision endpoint and answer with an error that names the wrong
          // service entirely.
          endpoint_path: joinCountTokensPath(candidate.endpoint),
          capabilities: candidate.capability_profile,
        };

        const upstream = await adapter.dispatchNativeService(upstreamBody, target, {
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

        // A count is free and generates nothing, so nothing is reserved or
        // committed. The attempt is still finalized: telemetry, the health
        // outcome, and the lease release have to happen exactly as they do on a
        // billed route, or a free endpoint becomes the one place those invariants
        // quietly stop holding.
        await completeAttempt(state, {
          status: upstream.ok ? "completed" : "failed",
          providerId: candidate.provider_id,
          ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
          ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
          ...(leases.proxySlot ? { networkPoolId: leases.proxySlot.poolId } : {}),
          usage: estimatedUsage(0, 0),
          modelId: candidate.model_id,
          lease: leases.lease,
          commitUsage: estimatedUsage(0, 0),
          terminal: true,
          tenantId: prepared.authorization.tenantId,
          ingressBody: state.ingressBody,
          responseBody: null,
          providerCapture,
          db: deps.db,
          ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
          ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
        });
        metrics.proxy_requests_total.inc(1, { status: upstream.ok ? "completed" : "failed" });

        // Verbatim: the client reads the provider's own number, and the
        // provider's own error when it refuses to produce one.
        const contentType = upstream.headers.get("content-type") ?? "application/json";
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { "content-type": contentType, "cache-control": "no-store", "x-request-id": state.requestId },
        });
      },
    });
  };
}

/**
 * Appends `/count_tokens` to the candidate's Messages endpoint.
 *
 * The stored endpoint is the chat path (`/v1/messages`), and the counter is its
 * sibling rather than a separate service. A trailing slash is normalized so a
 * row stored as `/v1/messages/` does not become `/v1/messages//count_tokens`.
 */
function joinCountTokensPath(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/count_tokens`;
}
