import type { Adapter, ProviderOutput, ProxyRequest, RouteTarget, StreamEvent } from "../contracts";
import type { AccountCandidate } from "../contracts";
import { createCleanupStack, deriveErrorSource } from "../contracts";
import type { ProxyAuthorization, ProxyRequestDependencies, RouteAttemptSelection, ProxyRoutePlan } from "./index";
import { beginProviderInFlight, endProviderInFlight } from "../../traffic/in-flight";
import { translateBody, resolveWireSurface } from "../../open-sse/translate";

const CODEX_PROXY_ENABLED = process.env.CARTETHYIA_CODEX_PROXY === "true";

interface RouteAttemptState {
  readonly selectedAttempts: Map<number, RouteAttemptSelection>;
  readonly accountCandidatesByProvider: Map<string, Promise<readonly AccountCandidate[]>>;
  successfulSelection: RouteAttemptSelection | null;
  successfulCandidateId: string | null;
}

function selectWireSurface(adapter: Adapter, request: ProxyRequest): ReturnType<typeof resolveWireSurface> {
  return resolveWireSurface(adapter.metadata, adapter.capabilities, request.sourceSurface);
}

export interface RouteAttemptContext {
  readonly input: { request: { signal: AbortSignal; headers: Headers }; authorization: ProxyAuthorization };
  readonly dependencies: ProxyRequestDependencies;
  readonly request: ProxyRequest;
  readonly plan: ProxyRoutePlan;
  readonly capture: { request(value: unknown): void; response(value: unknown): void; observeResponse(response: Response): Response; settle(): Promise<void> } | null;
  readonly state: RouteAttemptState;
}

export function createRouteAttemptState(): RouteAttemptState {
  return { selectedAttempts: new Map(), accountCandidatesByProvider: new Map(), successfulSelection: null, successfulCandidateId: null };
}

export function getRouteAttemptSelection(state: RouteAttemptState): RouteAttemptSelection | null {
  return state.successfulSelection;
}

export function getSuccessfulCandidateId(state: RouteAttemptState): string | null {
  return state.successfulCandidateId;
}

export function getSelectedAttempt(state: RouteAttemptState, index: number): RouteAttemptSelection | null {
  return state.selectedAttempts.get(index) ?? null;
}

export function clearAccountCandidates(state: RouteAttemptState, providerId: string): void {
  state.accountCandidatesByProvider.delete(providerId);
}

export function createRouteAttempt(context: RouteAttemptContext): (index: number) => Promise<ProviderOutput> {
  const { input, dependencies, request, plan, capture, state } = context;
  return async (index: number): Promise<ProviderOutput> => {
    const candidate = plan.candidates[index % plan.candidates.length];
    if (!candidate) throw { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "provider", source: deriveErrorSource("provider_unavailable", "provider"), sanitizedMessage: "No route candidate available", retryAt: null };
    const adapter = dependencies.providers.get(candidate.providerId);
    if (!adapter) throw { statusCode: 503, kind: "credential_unavailable", retryable: false, routeScope: "provider", source: deriveErrorSource("credential_unavailable", "provider"), sanitizedMessage: "Provider is not configured", retryAt: null };
    const attemptCleanup = createCleanupStack();
    let handedOff = false;
    try {
      const adapterNeedsCredential = adapter.metadata.credentialKind !== "none";
      const providerRouting = dependencies.getProviderRouting?.(candidate.providerId);
      const affinityKey = input.authorization.apiKeyId ?? input.authorization.trustedIdentity ?? "anonymous";
      let accountCandidatesPromise = state.accountCandidatesByProvider.get(candidate.providerId);
      if (accountCandidatesPromise === undefined) {
        accountCandidatesPromise = dependencies.accountCandidates(candidate.providerId).catch((error: unknown) => { state.accountCandidatesByProvider.delete(candidate.providerId); throw error; });
        state.accountCandidatesByProvider.set(candidate.providerId, accountCandidatesPromise);
      }
      const credential = adapterNeedsCredential ? await dependencies.accounts.select({ providerId: candidate.providerId, candidates: await accountCandidatesPromise, strategy: providerRouting?.strategy ?? "priority", affinityKey, stickyLimit: providerRouting?.useStickyLimit === true ? providerRouting.stickyLimit : undefined, modelId: candidate.modelId }) : null;
      if (adapterNeedsCredential && credential === null) throw { statusCode: 503, kind: "credential_unavailable", retryable: true, routeScope: "account", source: deriveErrorSource("credential_unavailable", "account"), sanitizedMessage: "No eligible account available", retryAt: null };
      if (credential !== null) attemptCleanup.add({ release: async () => dependencies.accounts.release(credential.selection.leaseId) });
      const network = await dependencies.network.select({ providerId: candidate.providerId, affinityKey, preferDirect: candidate.providerId === "codex" && !CODEX_PROXY_ENABLED });
      if (network === null) throw { statusCode: 503, kind: "network_unavailable", retryable: true, routeScope: "proxy", source: deriveErrorSource("network_unavailable", "proxy"), sanitizedMessage: "No outbound network path available", retryAt: null };
      attemptCleanup.add({ release: network.selection.release });
      const selected = { accountId: credential?.selection.accountId ?? null, proxyId: network.proxyId } satisfies RouteAttemptSelection;
      state.selectedAttempts.set(index, selected);
      const wireSurface = selectWireSurface(adapter, request);
      if (wireSurface === null) throw { statusCode: 400, kind: "capability_unsupported", retryable: false, routeScope: "provider", source: deriveErrorSource("capability_unsupported", "provider"), sanitizedMessage: `Provider "${candidate.providerId}" cannot translate this protocol surface`, retryAt: null };
      const target: RouteTarget = adapter.resolveTarget(candidate.modelId || request.model, wireSurface);
      let providerStreamHandedOff = false;
      beginProviderInFlight(candidate.providerId);
      let output: ProviderOutput;
      try {
        output = await adapter.call({ target, request, credential: credential?.selection.secret ?? "", network: network.selection, signal: input.request.signal, headers: input.request.headers, capture: capture ?? undefined });
      } catch (error) {
        endProviderInFlight(candidate.providerId);
        throw adapter.mapError(error);
      }
      state.successfulSelection = selected;
      state.successfulCandidateId = candidate.id;
      if (output.mode === "stream") {
        handedOff = true;
        providerStreamHandedOff = true;
        return { ...output, events: (async function*(): AsyncGenerator<StreamEvent> {
          try { for await (const event of output.events) yield event; }
          finally { endProviderInFlight(candidate.providerId); await attemptCleanup.run(); }
        })() };
      }
      if (!providerStreamHandedOff) endProviderInFlight(candidate.providerId);
      await attemptCleanup.run();
      if (output.mode === "non_stream" && target.surface !== request.sourceSurface) return { ...output, body: translateBody(output.body, adapter.metadata.protocol, target.surface, request.sourceSurface) };
      return output;
    } finally {
      if (!handedOff) await attemptCleanup.run();
    }
  };
}
