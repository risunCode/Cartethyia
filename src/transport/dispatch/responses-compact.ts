import type { ProviderAdapter } from "../../providers/provider-registry";
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
import type { CodexCompactAdapter } from "../../providers/integrations/codex/codex";
import { completeAttempt, estimatedUsage } from "./attempt-finalize";
import { repriceUsage, usageFromProvider } from "../../providers/usage";
import { runAttemptLoop } from "./attempt-loop";

/**
 * The native Codex compaction route (`POST /v1/responses/compact`) and the
 * dependency surface it needs to drive `runAttemptLoop`.
 */
export interface ResponsesCompactHandlerDeps {
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

/**
 * Handles `POST /v1/responses/compact`: the native Codex compaction proxy. The
 * wire body stays opaque — it is neither parsed nor projected — but routing,
 * admission, retry, accounting, and telemetry run through the same attempt
 * loop as the canonical proxy routes.
 */
export function createResponsesCompactHandler(deps: ResponsesCompactHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const body = state.ingressBody;
    if (!authorization || body === null || typeof body !== "object" || Array.isArray(body))
      throw new GatewayError("invalid_request", 400, "compact request body must be a JSON object");
    const compact = body as Record<string, unknown>;
    if (typeof compact.model !== "string" || compact.model.trim().length === 0)
      throw new GatewayError("invalid_request", 400, "model is required");
    // A thinking suffix (`model(high)`) is stripped here for the same reason the
    // canonical preparer strips it: this route matches the model name against
    // the allowlist and the route plan, and `(high)` is not part of any
    // registered id. The level itself is dropped rather than applied —
    // compaction is a context operation, not a generation, so there is no
    // reasoning effort to shape, and the body is passed upstream verbatim.
    // Stripping keeps a client that appends the suffix to every request working
    // here instead of failing with a misleading model-not-found.
    const { model: compactModel } = parseThinkingSuffix(compact.model);
    const compactBody: Record<string, unknown> =
      compactModel === compact.model ? compact : { ...compact, model: compactModel };
    if (!(typeof compact.input === "string" || Array.isArray(compact.input)))
      throw new GatewayError("invalid_request", 400, "input must be a string or array");
    if ("instructions" in compact && typeof compact.instructions !== "string")
      throw new GatewayError("invalid_request", 400, "instructions must be a string");
    if (compact.stream === true)
      throw new GatewayError(
        "capability_unsupported",
        400,
        "Responses compact does not support streaming",
      );
    const adapter = (deps.resolveProviderAdapter
      ? await deps.resolveProviderAdapter("codex")
      : deps.providerAdapters.get("codex")) as CodexCompactAdapter | undefined;
    if (!adapter || typeof adapter.compact !== "function")
      throw new GatewayError("admission_unavailable", 503, "Codex compact transport unavailable");
    const prepared = await deps.proxyPreparer.prepareNativeCompact({
      model: compactModel,
      authorization,
      signal: state.abortController.signal,
      ...(state.clientUserAgent === undefined ? {} : { clientUserAgent: state.clientUserAgent }),
    });
    return runAttemptLoop<Response, CodexCompactAdapter>({
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
        "no eligible Codex route",
      ),
      prepare: async (candidate) => {
        if (!candidate.provider_account_id)
          throw new GatewayError(
            "admission_unavailable",
            503,
            "Codex compact requires an OAuth account",
          );
        const credential = await resolveCredentialForAccount(
          deps.db,
          "codex",
          candidate.provider_account_id,
          deps.oauthRefreshService && deps.resolveOAuthRefresher
            ? { refreshService: deps.oauthRefreshService, resolveRefresher: deps.resolveOAuthRefresher }
            : undefined,
        );
        if (credential.credential_kind !== "oauth")
          throw new GatewayError(
            "capability_unsupported",
            400,
            "Responses compact requires a Codex ChatGPT OAuth account",
          );
        return { credential, adapter };
      },
      attempt: async (context) => {
        const { candidate, credential, leases, providerCapture } = context;
        const response = await adapter.compact(compactBody, {
          credential,
          deadline: state.deadlineMs,
          abort_signal: state.abortController.signal,
          ...(deps.networkBindingFactory
            ? {
                outbound_fetch: deps.networkBindingFactory.fetch(
                  leases.proxySlot?.poolId,
                  authorization.tenantId,
                ),
              }
            : {}),
        });
        // Prefer the usage the compaction endpoint actually reported. The
        // estimate is a fixed 1024+1024 reserve, and compaction is by
        // construction a large-input operation, so charging it unconditionally
        // let real spend run far past the counter. `usageFromProvider` returns
        // undefined when the body reported nothing, which keeps the estimate as
        // the fallback. `response.clone()` leaves the body readable for the
        // client.
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
