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
import { parseThinkingSuffix } from "../translation/thinking";
import { completeAttempt, estimatedUsage } from "./attempt-finalize";
import { repriceUsage, usageFromProvider } from "../../providers/usage";
import { runAttemptLoop } from "./attempt-loop";

/**
 * The native System One route (`POST /v1/systemone`) and the dependency surface
 * it needs to drive `runAttemptLoop`.
 *
 * System One is a decision protocol, not chat: the caller sends
 * `{model, state, questions}` and receives `{answers, usage}`. The body stays
 * opaque — neither parsed nor projected — but routing, admission, retry,
 * accounting, and telemetry run through the same attempt loop as every other
 * route. The provider's adapter method (`ProviderAdapter.systemone`) forwards
 * the body untouched.
 */
export interface SystemoneHandlerDeps {
  readonly db: CartethyiaDatabase;
  readonly providerAdapters: ReadonlyMap<string, ProviderAdapter>;
  /** Preferred over `providerAdapters`: resolves an adapter on demand and caches it. */
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

/** Adapter that can serve a System One decision request. */
type SystemoneAdapter = ProviderAdapter & {
  systemone: NonNullable<ProviderAdapter["systemone"]>;
};

export function createSystemoneHandler(deps: SystemoneHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const body = state.ingressBody;
    if (!authorization || body === null || typeof body !== "object" || Array.isArray(body))
      throw new GatewayError("invalid_request", 400, "systemone request body must be a JSON object");
    const decision = body as Record<string, unknown>;
    if (typeof decision.model !== "string" || decision.model.trim().length === 0)
      throw new GatewayError("invalid_request", 400, "model is required");
    // A thinking suffix (`model(high)`) is stripped for the same reason the
    // canonical preparer strips it: the route matches the model name against the
    // allowlist and the route plan, and `(high)` is not part of any registered
    // id. The level itself is dropped — a decision request carries no reasoning
    // effort to shape, and the body is passed upstream verbatim.
    const { model: bareModel } = parseThinkingSuffix(decision.model);
    const decisionBody: Record<string, unknown> =
      bareModel === decision.model ? decision : { ...decision, model: bareModel };
    // Trust boundary only: the decision model's own question shapes are
    // upstream's to validate. `state` and a `questions` object are what make a
    // System One request a System One request at all.
    if (decision.state === undefined || decision.state === null)
      throw new GatewayError("invalid_request", 400, "state is required");
    if (
      decision.questions === undefined ||
      decision.questions === null ||
      typeof decision.questions !== "object" ||
      Array.isArray(decision.questions)
    )
      throw new GatewayError("invalid_request", 400, "questions must be an object");
    const prepared = await deps.proxyPreparer.prepareNativeService({
      model: bareModel,
      serviceKind: "systemone",
      authorization,
      ...(state.abortController.signal ? { signal: state.abortController.signal } : {}),
      ...(state.clientUserAgent === undefined ? {} : { clientUserAgent: state.clientUserAgent }),
    });
    return runAttemptLoop<Response, SystemoneAdapter>({
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
      // Lenient pool semantics: a missing slot tolerates direct egress.
      strictPoolSelection: false,
      exhaustedError: new GatewayError(
        "admission_unavailable",
        503,
        "no eligible System One route",
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
        const adapter = (deps.resolveProviderAdapter
          ? await deps.resolveProviderAdapter(candidate.provider_id)
          : deps.providerAdapters.get(candidate.provider_id)) as SystemoneAdapter | undefined;
        if (!adapter || typeof adapter.systemone !== "function")
          throw new GatewayError(
            "capability_unsupported",
            400,
            "System One transport unavailable for this provider",
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
        // The caller names the model with its provider prefix
        // (`opencodeft/jev-1.13-free`); upstream expects the row's own bare id.
        // Every canonical dispatch rewrites `model` to `candidate.model_id`
        // (via the codecs), so the native body must do the same or the decision
        // endpoint answers "Model … is not supported".
        const upstreamBody =
          decisionBody.model === candidate.model_id
            ? decisionBody
            : { ...decisionBody, model: candidate.model_id };
        const response = await context.adapter.systemone(upstreamBody, target, {
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
        if (!response.ok) {
          // Surface the upstream decision error verbatim: it is the operator's
          // only signal for a rejected payload, and the attempt loop's retry
          // classifier reads the status from the thrown error.
          const detail = await response.text().catch(() => "");
          throw new GatewayError(
            response.status >= 500 ? "platform_unavailable" : "invalid_request",
            response.status,
            `System One upstream error: ${detail.slice(0, 240)}`,
          );
        }
        // Prefer the usage the decision endpoint reported; fall back to the
        // fixed native estimate. `response.clone()` leaves the body readable
        // for the client.
        let reportedUsage: ReturnType<typeof usageFromProvider>;
        try {
          const parsed: unknown = await response.clone().json();
          reportedUsage = usageFromProvider(
            typeof parsed === "object" && parsed !== null
              ? (parsed as Record<string, unknown>)["usage"]
              : undefined,
          );
        } catch {
          reportedUsage = undefined;
        }
        const usage = repriceUsage(
          reportedUsage ??
            estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens),
          candidate.provider_id,
          candidate.model_id,
        );
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
          responseBody: null,
          providerCapture,
          db: deps.db,
          ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
          ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
        });
        metrics.proxy_requests_total.inc(1, { status: "completed" });
        return new Response(response.body, {
          status: response.status,
          headers: {
            "content-type": response.headers.get("content-type") ?? "application/json",
            "cache-control": "no-store",
            "x-request-id": state.requestId,
          },
        });
      },
    });
  };
}
