/**
 * The native generation routes: `POST /v1/images/generations` and `POST
 * /v1/videos/generations`.
 *
 * A generation request is not chat-shaped — the caller sends `{model, prompt,
 * n, …}` and receives media — so routing it through the canonical chat codec
 * would either invent fields or drop the ones that matter. Both surfaces take
 * the shape of the web-search handler: validate the trust boundary, drive
 * `runAttemptLoop`, then hand back what the upstream produced.
 *
 * One handler serves both kinds because the only difference is the
 * `serviceKind` the route filters candidates by and the word used in errors.
 * Duplicating this for video would mean two copies of the same streaming,
 * accounting, and credential logic to keep in step.
 *
 * The video route is deliberately mounted with no model behind it: the operator
 * wants the surface present so it can be finished when an upstream is known,
 * and a missing route answers 404 in a way that looks like a typo rather than
 * an unfinished capability.
 */
import type { ImageGenerationOutcome, ProviderAdapter, ProviderDispatchTarget } from "../../providers/contracts";
import { GatewayError } from "../../protocol/gateway-error";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { OAuthTokenRefresher, OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RouteSnapshotService } from "../routing/route-model";
import type { ServiceKind } from "../../protocol/canonical-model";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProxyRequestState } from "../request/state";
import { ProxyRequestStateStore } from "../request/state";
import { ProxyRequestPreparer } from "../request/preparer";
import { completeAttempt, estimatedUsage } from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";

export interface GenerationHandlerDeps {
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

/** Which surface a handler serves. Drives candidate filtering and error copy. */
export type GenerationKind = Extract<ServiceKind, "imageGeneration" | "videoGeneration">;

/**
 * Maximum items one request may ask for.
 *
 * A bound on upstream fan-out, not a product limit: every item is billed to the
 * caller, so an unbounded `n` is an easy way to spend someone else's quota.
 */
const MAX_ITEMS_PER_REQUEST = 10;

function jsonResponse(payload: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

/**
 * Forwards a streaming upstream response to the client and accounts for it.
 *
 * A generated result can arrive as SSE, and the frames are the client's to
 * read: parsing them here fails on the first `data:` frame, and buffering the
 * whole stream would hold a multi-megabyte response in memory the caller is
 * waiting to consume. The attempt is still finalized first, so telemetry and
 * accounting behave the same as on the JSON path.
 */
async function passThrough(
  state: ProxyRequestState,
  upstream: Response,
  args: {
    readonly candidate: {
      provider_id: string;
      model_id: string;
      provider_account_id?: string;
      provider_account_label?: string;
    };
    readonly lease: unknown;
    readonly networkPoolId?: string;
    readonly tenantId: string;
    readonly providerCapture: unknown;
    readonly deps: GenerationHandlerDeps;
  },
): Promise<Response> {
  const usage = estimatedUsage(0, 0);
  await completeAttempt(state, {
    status: "completed",
    providerId: args.candidate.provider_id,
    ...(args.candidate.provider_account_id ? { accountId: args.candidate.provider_account_id } : {}),
    ...(args.candidate.provider_account_label ? { accountLabel: args.candidate.provider_account_label } : {}),
    ...(args.networkPoolId ? { networkPoolId: args.networkPoolId } : {}),
    usage,
    modelId: args.candidate.model_id,
    lease: args.lease as never,
    commitUsage: usage,
    terminal: true,
    tenantId: args.tenantId,
    ingressBody: state.ingressBody,
    responseBody: null,
    providerCapture: args.providerCapture as never,
    db: args.deps.db,
    ...(args.deps.telemetryBuffer ? { telemetryBuffer: args.deps.telemetryBuffer } : {}),
    ...(args.deps.snapshotService ? { snapshotService: args.deps.snapshotService } : {}),
  });
  metrics.proxy_requests_total.inc(1, { status: "completed" });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-store",
      "x-request-id": state.requestId,
    },
  });
}

/** Builds the handler for one generation surface. */
export function createGenerationHandler(kind: GenerationKind, deps: GenerationHandlerDeps) {
  const noun = kind === "videoGeneration" ? "video" : "image";
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const body = state.ingressBody;
    if (!authorization || body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new GatewayError(
        "invalid_request",
        400,
        `The ${noun} body must be a JSON object. Send one with at least a model and a prompt.`,
      );
    }
    const generation = body as Record<string, unknown>;
    if (typeof generation.model !== "string" || generation.model.trim().length === 0) {
      throw new GatewayError("invalid_request", 400, `A model is required: it names the ${noun} provider to use.`);
    }
    if (!authorization.snapshot.scopes?.includes("routing:invoke" as never)) {
      throw new GatewayError(
        "invalid_request",
        403,
        `${noun} generation not allowed for this key — enable routing:invoke on the API key`,
      );
    }
    // Trust boundary only. Both `prompt` and `messages` are accepted because
    // the upstream decides which it wants: cb's image endpoint is a chat
    // endpoint that reads `messages`, so mandating `prompt` would reject a body
    // the provider is perfectly happy with.
    const hasPrompt = typeof generation.prompt === "string" && generation.prompt.trim().length > 0;
    const hasMessages = Array.isArray(generation.messages) && generation.messages.length > 0;
    if (!hasPrompt && !hasMessages) {
      throw new GatewayError("invalid_request", 400, "prompt is required");
    }
    if (generation.n !== undefined) {
      const n = generation.n;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_ITEMS_PER_REQUEST) {
        throw new GatewayError(
          "invalid_request",
          400,
          `n must be an integer between 1 and ${MAX_ITEMS_PER_REQUEST}`,
        );
      }
    }

    const prepared = await deps.proxyPreparer.prepareNativeService({
      model: generation.model,
      serviceKind: kind,
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
      exhaustedError: new GatewayError("admission_unavailable", 503, `no eligible ${noun} generation route`),
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
          throw new GatewayError(
            "capability_unsupported",
            400,
            `${noun} generation is unavailable for this provider`,
          );
        }
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
        // Name the model the route actually resolved to: a caller may address a
        // model through an alias, and the upstream must see the real id.
        const upstreamBody =
          generation.model === candidate.model_id
            ? generation
            : { ...generation, model: candidate.model_id };

        const adapter = context.adapter;
        const finish = async (
          response: Record<string, unknown> | ImageGenerationOutcome,
        ): Promise<Response> => {
          const payload = {
            provider: candidate.provider_id,
            model: candidate.model_id,
            ...response,
          };
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
        };

        // Prefer the provider's own method; otherwise post the body to the
        // candidate's endpoint through the adapter, which owns the upstream base
        // URL. Either way the gateway does not interpret the media — it returns
        // what the upstream produced.
        const upstream =
          typeof adapter.generateImage === "function"
            ? await adapter.generateImage(upstreamBody, target, {
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
              }).then((outcome) => finish(outcome))
            : typeof adapter.dispatchNativeService !== "function"
              ? Promise.reject(
                  new GatewayError(
                    "capability_unsupported",
                    400,
                    `${noun} generation is unavailable for this provider`,
                  ),
                )
              : adapter
                  .dispatchNativeService(upstreamBody, target, {
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
                  })
                  .then(async (res) => {
                    const contentType = res.headers.get("content-type") ?? "";
                    if (contentType.includes("text/event-stream")) {
                      return passThrough(state, res, {
                        candidate,
                        lease: leases.lease,
                        ...(leases.proxySlot ? { networkPoolId: leases.proxySlot.poolId } : {}),
                        tenantId: prepared.authorization.tenantId,
                        providerCapture,
                        deps,
                      });
                    }
                    const parsed: unknown = await res.json();
                    return finish(
                      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                        ? (parsed as Record<string, unknown>)
                        : { data: [parsed] },
                    );
                  });
        return upstream;
      },
    });
  };
}

/** `POST /v1/images/generations`. */
export function createImageGenerationHandler(deps: GenerationHandlerDeps) {
  return createGenerationHandler("imageGeneration", deps);
}

/** `POST /v1/videos/generations`. */
export function createVideoGenerationHandler(deps: GenerationHandlerDeps) {
  return createGenerationHandler("videoGeneration", deps);
}
