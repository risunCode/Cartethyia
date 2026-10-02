/**
 * Fusion request execution: the transport side of a `fusion` combo.
 *
 * `fusion.ts` owns the pure panel/judge orchestration; this module supplies the
 * one thing it cannot know — how to run a canonical request against a single
 * model through the shared lease/credential/adapter path — and turns the final
 * answer into a client-surface `Response`.
 *
 * Accounting follows the failover model the attempt loop already uses: each
 * panel model is a real upstream call, so it acquires its own leases, commits
 * its own usage, and reports its own health with `terminal: false` (no telemetry
 * row, no outcome claim). The final attempt — the judge, or the lone surviving
 * panel model — is terminal, so it records the real outcome and emits the one
 * telemetry row the request is owed.
 */
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../providers/provider-registry";
import type { CanonicalEvent, CanonicalRequest } from "../canonical-model";
import { GatewayError } from "../gateway-error";
import { resolveCredentialForAccount } from "../../providers/operations/provider-credential-service";
import type { OAuthTokenRefresher, OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import type { RouteCandidate, RouteSnapshotService } from "../routing/route-model";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import type { ProxyRequestState } from "../request/state";
import type { ProxyRequestPreparer, PreparedProxyRequest } from "../request/preparer";
import { isModelAllowed } from "../../security/api-key-auth";
import { completeAttempt, estimatedUsage } from "./attempt-finalize";
import { acquireAttemptLeases, releaseAttemptLeases } from "./leases";
import { runFusionPanel } from "../routing/fusion";
import { buildUpstreamDispatchContext } from "./upstream";

export interface FusionDispatchDeps {
  readonly db: CartethyiaDatabase;
  readonly providerAdapters: ReadonlyMap<string, ProviderAdapter>;
  readonly resolveProviderAdapter?: (providerId: string) => Promise<ProviderAdapter | undefined>;
  readonly proxyPreparer: ProxyRequestPreparer;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly poolSelector?: NetworkPoolSelector;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

/** The events one model produced, and the candidate that served them. */
interface ModelDispatch {
  readonly events: readonly CanonicalEvent[];
  readonly candidate: RouteCandidate;
}

function candidateTarget(candidate: RouteCandidate): ProviderDispatchTarget {
  return {
    provider_id: candidate.provider_id as ProviderAdapter["provider_id"],
    model_id: candidate.model_id,
    wire_family: candidate.wire_family,
    endpoint_path: candidate.endpoint,
    capabilities: candidate.capability_profile,
  };
}

/** Concatenates the answer text from a non-streaming event list. */
function textOf(events: readonly CanonicalEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === "content_delta" && event.content.kind === "text") parts.push(event.content.text);
  }
  return parts.join("");
}

/** Appends a single user turn to a canonical request, for the judge synthesis. */
function appendUserTurn(request: CanonicalRequest, text: string): CanonicalRequest {
  return {
    ...request,
    messages: [...request.messages, { role: "user", content: [{ kind: "text", text }] }],
  };
}

/**
 * Runs one canonical request against one model: prepare → lease → credential →
 * adapter → dispatch → complete → release.
 *
 * `terminal` selects the accounting mode: a panel model passes `false` (usage
 * committed, health reported, no telemetry row, no outcome claim); the final
 * attempt passes `true`. Returns the events so the caller can read text or
 * encode the client response.
 */
async function dispatchModel(
  state: ProxyRequestState,
  deps: FusionDispatchDeps,
  authorization: PreparedProxyRequest["authorization"],
  model: string,
  request: CanonicalRequest,
  inboundHeaders: Record<string, string>,
  terminal: boolean,
): Promise<ModelDispatch> {
  const prepared = await deps.proxyPreparer.prepare({
    canonicalRequest: { ...request, model },
    authorization,
    deadlineMs: state.deadlineMs,
    ...(state.abortController.signal ? { signal: state.abortController.signal } : {}),
  });
  const candidate = prepared.candidate;
  const leaseSource = {
    admissionService: prepared.admissionService,
    routingEngine: prepared.routingEngine,
    plan: prepared.plan,
    estimatedInputTokens: prepared.estimatedInputTokens,
    estimatedOutputTokens: prepared.estimatedOutputTokens,
    authorizationSnapshot: prepared.authorization.snapshot,
  };
  const leases = await acquireAttemptLeases(leaseSource, candidate, {
    signal: state.abortController.signal,
    ...(deps.poolSelector ? { poolSelector: deps.poolSelector } : {}),
    ...(deps.networkBindingFactory ? { networkBindingFactory: deps.networkBindingFactory } : {}),
    strictPoolSelection: false,
  });
  try {
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
    if (!adapter) throw new GatewayError("admission_unavailable", 503, "provider adapter not registered");
    const dispatchContext = buildUpstreamDispatchContext({
      credential,
      deadline: state.deadlineMs,
      signal: state.abortController.signal,
      headers: inboundHeaders,
      ...(deps.networkBindingFactory
        ? {
            outboundFetch: deps.networkBindingFactory.fetch(
              leases.networkPoolId,
              prepared.authorization.snapshot.tenant_id,
            ),
          }
        : {}),
    }) as unknown as ProviderDispatchContext;
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(
      { ...request, model: candidate.model_id },
      candidateTarget(candidate) as never,
      dispatchContext as never,
    )) {
      events.push(event);
    }
    // A real upstream call: commit its usage estimate and report its health.
    // Only the terminal attempt claims the outcome and emits telemetry.
    const usage = estimatedUsage(prepared.estimatedInputTokens, prepared.estimatedOutputTokens);
    await completeAttempt(state, {
      status: "completed",
      providerId: candidate.provider_id,
      ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
      ...(leases.networkPoolId ? { networkPoolId: leases.networkPoolId } : {}),
      usage,
      modelId: candidate.model_id,
      lease: leases.lease,
      commitUsage: usage,
      terminal,
      tenantId: prepared.authorization.tenantId,
      ingressBody: state.ingressBody,
      responseBody: null,
      db: deps.db,
      ...(deps.telemetryBuffer && terminal ? { telemetryBuffer: deps.telemetryBuffer } : {}),
      ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
    });
    if (terminal) metrics.proxy_requests_total.inc(1, { status: "completed" });
    return { events, candidate };
  } finally {
    await releaseAttemptLeases(
      { lease: leases.lease, reservation: leases.reservation, proxySlot: leases.proxySlot },
      leaseSource.routingEngine,
    );
  }
}

/**
 * Executes a fusion combo and returns the canonical events of the final answer
 * plus the candidate that produced it.
 *
 * Panel models answer non-streaming with tools stripped (the judge needs
 * complete prose, and a panel model that emitted tool calls would have no text
 * to fuse). The final attempt keeps the client's original stream flag and tools,
 * so streaming and downstream tool use still work. The caller encodes the
 * returned events onto the client's surface, exactly as the normal dispatch path
 * does, so fusion shares that surface handling rather than forking it.
 */
export async function dispatchFusionRequest(input: {
  readonly state: ProxyRequestState;
  readonly deps: FusionDispatchDeps;
  readonly prepared: PreparedProxyRequest;
  readonly canonicalRequest: CanonicalRequest;
  readonly inboundHeaders: Record<string, string>;
  readonly fusion: { readonly panel: readonly string[]; readonly judge: string };
}): Promise<{ readonly events: readonly CanonicalEvent[]; readonly candidate: RouteCandidate }> {
  const { state, deps, prepared, canonicalRequest, fusion } = input;
  for (const model of fusion.panel) {
    if (!isModelAllowed(prepared.authorization.snapshot, model))
      throw new GatewayError(
        "model_not_found",
        404,
        "fusion panel model is not allowed for this API key",
        { model },
      );
  }
  // One logical request: the panel and judge share its in-flight gauge entry.
  state.startProviderFlight();
  // Panel models run non-streaming with tools stripped: the panel contributes
  // prose, not tool calls, and a non-streaming call cannot half-forward.
  const { tools: _tools, tool_choice: _toolChoice, ...withoutTools } = canonicalRequest;
  const panelRequest: CanonicalRequest = { ...withoutTools, stream: false };
  const outcome = await runFusionPanel({
    panel: fusion.panel,
    judge: fusion.judge,
    dispatchPanel: async (model) => {
      const dispatch = await dispatchModel(
        state,
        deps,
        prepared.authorization,
        model,
        panelRequest,
        input.inboundHeaders,
        false,
      );
      return textOf(dispatch.events);
    },
  });
  if (outcome.kind === "empty")
    throw new GatewayError("platform_unavailable", 503, "all fusion panel models failed");
  if (outcome.kind === "direct") {
    // The lone survivor's own text is the answer. Its panel events were already
    // accounted; this is the terminal attempt that claims the request outcome.
    const dispatch = await dispatchModel(
      state,
      deps,
      prepared.authorization,
      outcome.model,
      canonicalRequest,
      input.inboundHeaders,
      true,
    );
    return { events: dispatch.events, candidate: dispatch.candidate };
  }
  const finalRequest = appendUserTurn(canonicalRequest, outcome.prompt);
  const dispatch = await dispatchModel(
    state,
    deps,
    prepared.authorization,
    outcome.judgeModel,
    finalRequest,
    input.inboundHeaders,
    true,
  );
  return { events: dispatch.events, candidate: dispatch.candidate };
}
