import type { Adapter, ProviderOutput, ProxyRequest, RouteCandidate, RouteTarget, StreamEvent, Surface, TranslationDiagnostic } from "../contracts";
import type { AccountCandidate } from "../contracts";
import type { CredentialKind } from "../contracts";
import { createCleanupStack, deriveErrorSource } from "../contracts";
import type { ProxyAuthorization, ProxyRequestDependencies, RouteAttemptSelection, ProxyRoutePlan } from "./index";
import { beginProviderInFlight, endProviderInFlight } from "../../traffic/in-flight";
import { translateNonStreamResponse, resolveModelWireSurface } from "../../open-sse/translate";

const CODEX_PROXY_ENABLED = process.env.CARTETHYIA_CODEX_PROXY === "true";

interface RouteAttemptState {
  readonly selectedAttempts: Map<number, RouteAttemptSelection>;
  readonly selectedCredentialKinds: Map<number, CredentialKind>;
  readonly selectedCandidateIds: Map<number, string>;
  readonly translationDiagnostics: TranslationDiagnostic[];
  readonly reactiveRefreshes: Set<string>;
  readonly accountCandidatesByProvider: Map<string, Promise<readonly AccountCandidate[]>>;
  reactiveRetryCandidateId: string | null;
  accountRetryCandidateId: string | null;
  nextCandidateIndex: number;
  successfulSelection: RouteAttemptSelection | null;
  successfulCandidateId: string | null;
}
export function markAccountRetry(state: RouteAttemptState, candidateId: string): void {
  state.accountRetryCandidateId = candidateId;
}

function consumeRetryCandidate(state: RouteAttemptState): string | null {
  const candidateId = state.reactiveRetryCandidateId ?? state.accountRetryCandidateId;
  state.reactiveRetryCandidateId = null;
  state.accountRetryCandidateId = null;
  return candidateId;
}

function selectWireSurface(adapter: Adapter, candidate: { readonly modelId: string }, request: ProxyRequest): Surface | null {
  const model = adapter.models.get(candidate.modelId);
  return resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, request.sourceSurface);
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
  return { selectedAttempts: new Map(), selectedCredentialKinds: new Map(), selectedCandidateIds: new Map(), translationDiagnostics: [], reactiveRefreshes: new Set(), accountCandidatesByProvider: new Map(), reactiveRetryCandidateId: null, accountRetryCandidateId: null, nextCandidateIndex: 0, successfulSelection: null, successfulCandidateId: null };
}

export function getRouteAttemptSelection(state: RouteAttemptState): RouteAttemptSelection | null {
  return state.successfulSelection;
}
export function getTranslationDiagnostics(state: RouteAttemptState): readonly TranslationDiagnostic[] {
  return state.translationDiagnostics;
}

export function getSuccessfulCandidateId(state: RouteAttemptState): string | null {
  return state.successfulCandidateId;
}

export function getSelectedAttempt(state: RouteAttemptState, index: number): RouteAttemptSelection | null {
  return state.selectedAttempts.get(index) ?? null;
}

export function getSelectedCandidateId(state: RouteAttemptState, index: number): string | null {
  return state.selectedCandidateIds.get(index) ?? null;
}

export function getSelectedCredentialKind(state: RouteAttemptState, index: number): CredentialKind | null {
  return state.selectedCredentialKinds.get(index) ?? null;
}

export function markReactiveRefresh(state: RouteAttemptState, accountId: string, candidateId: string): boolean {
  if (state.reactiveRefreshes.has(accountId)) return false;
  state.reactiveRefreshes.add(accountId);
  state.reactiveRetryCandidateId = candidateId;
  return true;
}

export function hasNextCandidate(state: RouteAttemptState, plan: ProxyRoutePlan): boolean {
  return state.nextCandidateIndex < plan.candidates.length;
}

export function getNextCandidateId(state: RouteAttemptState, plan: ProxyRoutePlan): string | null {
  return plan.candidates[state.nextCandidateIndex]?.id ?? null;
}

export function clearAccountCandidates(state: RouteAttemptState, providerId: string): void {
  state.accountCandidatesByProvider.delete(providerId);
}

export function createRouteAttempt(context: RouteAttemptContext): (index: number) => Promise<ProviderOutput> {
  const { input, dependencies, request, plan, capture, state } = context;
  return async (index: number): Promise<ProviderOutput> => {
    let candidate: RouteCandidate | undefined;
    const retryCandidateId = consumeRetryCandidate(state);
    if (retryCandidateId !== null) {
      candidate = plan.candidates.find((item) => item.id === retryCandidateId);
    } else {
      const candidateIndex = state.nextCandidateIndex;
      state.nextCandidateIndex += 1;
      candidate = plan.candidates[candidateIndex];
    }
    if (!candidate) throw { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "provider", source: deriveErrorSource("provider_unavailable", "provider"), sanitizedMessage: "No route candidate available", retryAt: null };
    state.selectedCandidateIds.set(index, candidate.id);
    const adapter = dependencies.providers.get(candidate.providerId);
    if (!adapter) throw { statusCode: 503, kind: "credential_unavailable", retryable: false, routeScope: "provider", source: deriveErrorSource("credential_unavailable", "provider"), sanitizedMessage: "Provider is not configured", retryAt: null };
    const attemptCleanup = createCleanupStack();
    let handedOff = false;
    try {
      const adapterNeedsCredential = adapter.metadata.credentialKind !== "none";
      const providerRouting = dependencies.getProviderRouting?.(candidate.providerId);
      const affinityKey = input.authorization.apiKeyId ?? input.authorization.trustedIdentity ?? "anonymous";
      let stickyLimit: number | undefined;
      if (request.cacheKey !== undefined) {
        stickyLimit = Math.max(1, providerRouting?.stickyLimit ?? 1);
      } else if (providerRouting?.useStickyLimit === true) {
        stickyLimit = providerRouting.stickyLimit;
      }
      let accountCandidatesPromise = state.accountCandidatesByProvider.get(candidate.providerId);
      if (accountCandidatesPromise === undefined) {
        accountCandidatesPromise = dependencies.accountCandidates(candidate.providerId).catch((error: unknown) => { state.accountCandidatesByProvider.delete(candidate.providerId); throw error; });
        state.accountCandidatesByProvider.set(candidate.providerId, accountCandidatesPromise);
      }
      const credential = adapterNeedsCredential ? await dependencies.accounts.select({ providerId: candidate.providerId, candidates: await accountCandidatesPromise, strategy: providerRouting?.strategy ?? "priority", affinityKey, stickyLimit, modelId: candidate.modelId }) : null;
      if (adapterNeedsCredential && credential === null) throw { statusCode: 503, kind: "credential_unavailable", retryable: true, routeScope: "account", source: deriveErrorSource("credential_unavailable", "account"), sanitizedMessage: "No eligible account available", retryAt: null };
      if (credential !== null) attemptCleanup.add({ release: async () => dependencies.accounts.release(credential.selection.leaseId) });
      const network = await dependencies.network.select({ providerId: candidate.providerId, affinityKey, sticky: request.cacheKey !== undefined || providerRouting?.useStickyLimit === true, preferDirect: candidate.providerId === "codex" && !CODEX_PROXY_ENABLED });
      if (network === null) throw { statusCode: 503, kind: "network_unavailable", retryable: true, routeScope: "proxy", source: deriveErrorSource("network_unavailable", "proxy"), sanitizedMessage: "No outbound network path available", retryAt: null };
      attemptCleanup.add({ release: network.selection.release });
      const selected = { accountId: credential?.selection.accountId ?? null, proxyId: network.proxyId } satisfies RouteAttemptSelection;
      state.selectedAttempts.set(index, selected);
      state.selectedCredentialKinds.set(index, credential?.account.credentialKind ?? "none");
      state.selectedCandidateIds.set(index, candidate.id);
      const wireSurface = selectWireSurface(adapter, candidate, request);
      if (wireSurface === null) throw { statusCode: 400, kind: "capability_unsupported", retryable: false, routeScope: "provider", source: deriveErrorSource("capability_unsupported", "provider"), sanitizedMessage: `Provider "${candidate.providerId}" cannot translate this protocol surface`, retryAt: null };
      const target: RouteTarget = adapter.resolveTarget(candidate.modelId || request.model, wireSurface);
      let providerStreamHandedOff = false;
      beginProviderInFlight(candidate.providerId);
      let output: ProviderOutput;
      try {
        output = await adapter.call({ target, request, credential: credential?.selection.secret ?? "", network: network.selection, signal: input.request.signal, headers: input.request.headers, capture: capture ?? undefined, recordDiagnostic: (diagnostic) => { if (state.translationDiagnostics.length < 32) state.translationDiagnostics.push(diagnostic); } });
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
      if (output.mode === "non_stream" && target.surface !== request.sourceSurface) return { ...output, body: translateNonStreamResponse(output.body, target.surface, request.sourceSurface, request.model) };
      return output;
    } finally {
      if (!handedOff) await attemptCleanup.run();
    }
  };
}
