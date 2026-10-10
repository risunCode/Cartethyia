/**
 * The native image-generation route (`POST /v1/images/generations`).
 *
 * An image request is not chat-shaped: the caller sends `{model, prompt, n,
 * size, …}` and receives generated images, so routing through the canonical
 * chat codec would either invent fields or drop the ones that matter. This
 * route takes the same shape as the web-search handler — trust boundary,
 * `runAttemptLoop`, then serialize — because routing, admission, retry,
 * accounting and telemetry must behave identically on every `/v1` surface.
 *
 * The body is forwarded to the upstream largely untouched, exactly like the
 * search route: `candidate.endpoint_path` decides where it goes, so a
 * provider's own generation path is reachable without the gateway learning
 * that provider's wire.
 */
import type { ImageGenerationOutcome, ProviderAdapter, ProviderDispatchTarget } from "../../providers/contracts";
import { GatewayError } from "../../protocol/gateway-error";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { OAuthTokenRefresher, OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RouteSnapshotService } from "../routing/route-model";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { ProxyRequestStateStore, type ProxyRequestState } from "../request/state";
import { ProxyRequestPreparer } from "../request/preparer";
import { completeAttempt, estimatedUsage } from "./attempt-finalize";
import { runAttemptLoop } from "./attempt-loop";

export interface ImageGenerationHandlerDeps {
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

/**
 * Maximum images one request may ask for.
 *
 * A bound on the upstream fan-out, not a product limit: every image is billed
 * to the caller, so an unbounded `n` is an easy way to spend someone else's
 * quota.
 */
const MAX_IMAGES_PER_REQUEST = 10;

function jsonResponse(payload: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

/**
 * Forwards a streaming upstream response to the client and accounts for it.
 *
 * A generated image can arrive as SSE, and the frames are the client's to read —
 * buffering them here would both fail to parse and hold the whole response in
 * memory. The attempt is still finalized before the body is handed over, so
 * telemetry and accounting behave the same as on the JSON path.
 */
async function passThrough(
  state: ProxyRequestState,
  upstream: Response,
  args: {
    readonly candidate: { provider_id: string; model_id: string; provider_account_id?: string; provider_account_label?: string };
    readonly leases: { lease: unknown; proxySlot?: { poolId: string } };
    readonly tenantId: string;
    readonly providerCapture: unknown;
    readonly deps: ImageGenerationHandlerDeps;
  },
): Promise<Response> {
  await completeAttempt(state, {
    status: "completed",
    providerId: args.candidate.provider_id,
    ...(args.candidate.provider_account_id ? { accountId: args.candidate.provider_account_id } : {}),
    ...(args.candidate.provider_account_label ? { accountLabel: args.candidate.provider_account_label } : {}),
    ...(args.leases.proxySlot ? { networkPoolId: args.leases.proxySlot.poolId } : {}),
    usage: estimatedUsage(0, 0),
    modelId: args.candidate.model_id,
    lease: args.leases.lease as never,
    commitUsage: estimatedUsage(0, 0),
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

export function createImageGenerationHandler(deps: ImageGenerationHandlerDeps) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const state = deps.stateStore.require(request);
    const authorization = state.authorization;
    const body = state.ingressBody;
    if (!authorization || body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new GatewayError(
        "invalid_request",
        400,
        "The image body must be a JSON object. Send one with at least a model and a prompt.",
      );
    }
    const image = body as Record<string, unknown>;
    if (typeof image.model !== "string" || image.model.trim().length === 0) {
      throw new GatewayError("invalid_request", 400, "A model is required: it names the image provider to use.");
    }
    if (!authorization.snapshot.scopes?.includes("routing:invoke" as never)) {
      throw new GatewayError(
        "invalid_request",
        403,
        "image generation not allowed for this key — enable routing:invoke on the API key",
      );
    }
    // Trust boundary only: the request must carry something to generate from.
    // Both shapes are accepted rather than mandating `prompt`, because the
    // upstream decides which one it wants — cb's image endpoint is a chat
    // endpoint that reads `messages`, and forcing `prompt` here would reject a
    // body the provider is perfectly happy with. `n` is still bounded: every
    // image is billed to the caller.
    const hasPrompt = typeof image.prompt === "string" && image.prompt.trim().length > 0;
    const hasMessages =
      Array.isArray(image.messages) &&
      image.messages.length > 0;
    if (!hasPrompt && !hasMessages) {
      throw new GatewayError("invalid_request", 400, "prompt is required");
    }
    if (image.n !== undefined) {
      const n = image.n;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_REQUEST) {
        throw new GatewayError(
          "invalid_request",
          400,
          `n must be an integer between 1 and ${MAX_IMAGES_PER_REQUEST}`,
        );
      }
    }

    const prepared = await deps.proxyPreparer.prepareNativeService({
      model: image.model,
      serviceKind: "imageGeneration",
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
      exhaustedError: new GatewayError("admission_unavailable", 503, "no eligible image generation route"),
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
            "image generation is unavailable for this provider",
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
          image.model === candidate.model_id
            ? image
            : { ...image, model: candidate.model_id };

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
        // Prefer the provider's own image method; otherwise post the body to the
        // candidate's endpoint through the adapter, which owns the upstream base
        // URL. Either way the gateway does not interpret the images — it returns
        // what the upstream produced.
        if (typeof adapter.generateImage === "function") {
          const imageOutcome = await adapter.generateImage(upstreamBody, target, {
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
          return finish(imageOutcome);
        }
        // No bespoke image method: the adapter still owns the upstream base URL,
        // so ask it to run this model's own endpoint rather than building a URL
        // here — the candidate carries the path, never the host.
        if (typeof adapter.dispatchNativeService !== "function") {
          throw new GatewayError(
            "capability_unsupported",
            400,
            "image generation is unavailable for this provider",
          );
        }
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
        // A streaming upstream is passed through untouched. Parsing it as JSON
        // here is wrong twice over: it fails on the very first `data:` frame,
        // and buffering the whole stream would hold an image response in memory
        // that the client is waiting to consume.
        const contentType = upstream.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          return passThrough(state, upstream, {
            candidate,
            leases,
            tenantId: prepared.authorization.tenantId,
            providerCapture,
            deps,
          });
        }
        const parsed: unknown = await upstream.json();
        return finish(
          typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { data: [parsed] },
        );
      },
    });
  };
}
