import { createCleanupStack, sanitizeMessage, deriveErrorSource, type ProviderCallError } from "../domain/contracts";
import type { PresentedProxyResponse } from "../domain/contracts";
import type { ProviderAdapter, ProviderOutput, ProviderUsage, RouteTarget } from "../domain/contracts";
import type { AccountCandidate, AffinityKey, RouteCandidate, RouteSwitch } from "../domain/contracts";
import type { NormalizedProviderRequest, RunProxyRequestInput } from "../domain/contracts";
import { detectClient } from "../domain/contracts";
import type { ClientIdentity } from "../domain/contracts";
import type { RequestTelemetryHandle, TelemetryWriter } from "../domain/contracts";
import { applyCachePlan, buildCachePlan } from "../domain/cache";
import { isRouteAllowed } from "../console/key-acl";
import { isProtocolError, normalizeRequest, parseRequestBody } from "../domain/protocols";
import { CredentialSelector } from "../auth";
import { NetworkSelector } from "../traffic";
import { beginProviderInFlight, decrementInFlight, endProviderInFlight, incrementInFlight } from "../traffic/in-flight";
import { ApiKeyAdmission, estimateRequestTokens, type AdmissionLease, type AdmissionUsage } from "../traffic/admission";
import type { ApiKeyPublic } from "../storage";
import { isProviderCallError, recoverCall } from "./recovery";
import { translateNonStreamResponse, wireSurfaceFor } from "../domain/protocols/translation";
import { writeErrorResponse, writeResponse } from "./response";
import { applyTokenSaver, type TokenSaverConfig } from "../domain/token-saver";
import { applyFilterRules, type FilterRuleConfig } from "../domain/filter-rules";

export interface ProxyRoutePlan {
  readonly affinity: AffinityKey;
  readonly candidates: readonly RouteCandidate[];
  readonly requestedModel?: string;
}

export interface RouteAttemptSelection {
  readonly accountId: string | null;
  readonly proxyId: string | null;
}

export interface ProxyRequestLogEvent {
  readonly event: "incoming" | "complete" | "failed";
  readonly requestId: string;
  readonly endpoint: RunProxyRequestInput["endpoint"];
  readonly providerId: string | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly clientName: string;
  readonly clientSource: string;
  readonly clientIp: string | null;
}

export interface ProxyRequestDependencies {
  readonly providers: { get(providerId: string): ProviderAdapter | undefined };
  readonly accounts: CredentialSelector;
  readonly network: NetworkSelector;
  readonly telemetry: TelemetryWriter;
  readonly resolveRoutes: (request: NormalizedProviderRequest, affinity: AffinityKey) => Promise<ProxyRoutePlan>;
  readonly accountCandidates: (providerId: string) => Promise<readonly AccountCandidate[]>;
  readonly getProviderRouting?: (providerId: string) => { readonly strategy: "priority" | "round-robin"; readonly stickyLimit: number; readonly useStickyLimit: boolean };
  readonly onRouteFailure?: (candidate: RouteCandidate, error: ProviderCallError, selected: RouteAttemptSelection | null) => Promise<void>;
  readonly onRouteSuccess?: (candidate: RouteCandidate, selected: RouteAttemptSelection | null) => Promise<void>;
  readonly onRouteSwitch?: (event: RouteSwitch) => Promise<void>;
  readonly onRequestLog?: (event: ProxyRequestLogEvent) => void;
  readonly admission?: ApiKeyAdmission;
  readonly maxAttempts?: number;
  readonly tokenSaver?: () => TokenSaverConfig;
  readonly filterRules?: () => FilterRuleConfig;
}

export interface ProxyAuthorization {
  readonly apiKeyId: string | null;
  readonly apiKey?: ApiKeyPublic;
  readonly trustedIdentity: string | null;
  readonly providerAllowlist?: readonly string[] | null;
  readonly modelAllowlist?: readonly string[] | null;
  readonly modelDenylist?: readonly string[] | null;
}

export interface AuthorizedProxyRequestInput {
  readonly request: RunProxyRequestInput;
  readonly authorization: ProxyAuthorization;
}

const DEFAULT_LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
} as const;

function normalizeError(error: unknown): ProviderCallError {
  if (isProviderCallError(error)) return error;
  return {
    statusCode: null,
    kind: "internal_error",
    retryable: false,
    routeScope: null,
    source: deriveErrorSource("internal_error", null),
    sanitizedMessage: sanitizeMessage(error),
    retryAt: null,
  };
}

function telemetryStart(input: RunProxyRequestInput, requestId: string, client: ClientIdentity, authorization: ProxyAuthorization, telemetry: TelemetryWriter): RequestTelemetryHandle {
  return telemetry.start({
    requestId,
    endpoint: input.endpoint,
    surface: input.surface,
    apiKeyId: authorization.apiKeyId,
    apiKeyPrefix: authorization.apiKey?.keyPrefix ?? null,
    clientIp: input.clientIp ?? null,
    clientName: client.name,
    clientSource: client.source,
    startedAt: new Date().toISOString(),
    messageCount: 0,
    toolCount: 0,
    imageCount: 0,
  });
}

export async function runProxyRequest(input: AuthorizedProxyRequestInput, dependencies: ProxyRequestDependencies): Promise<PresentedProxyResponse> {
  const requestId = input.request.requestId ?? crypto.randomUUID();
  const startedAt = performance.now();
  const client = detectClient(input.request.headers);
  const telemetry = telemetryStart(input.request, requestId, client, input.authorization, dependencies.telemetry);
  let requestLogSettled = false;
  const emitRequestLog = (event: ProxyRequestLogEvent): void => {
    if (event.event !== "incoming") {
      if (requestLogSettled) return;
      requestLogSettled = true;
    }
    dependencies.onRequestLog?.(event);
  };
  const cleanup = createCleanupStack();
  let admissionLease: AdmissionLease | null = null;
  let admissionSettled = false;
  let admissionEstimate = 0;
  let normalizedRequest: NormalizedProviderRequest | undefined;
  let resolvedPlan: ProxyRoutePlan | undefined;
  let streamHandedOff = false;
  const settleAdmission = (usage: AdmissionUsage | null): void => {
    if (admissionSettled || admissionLease === null) return;
    admissionSettled = true;
    if (usage === null) admissionLease.release();
    else admissionLease.commit(usage);
  };

  incrementInFlight();
  try {
    const parsed = typeof input.request.body === "string" ? parseRequestBody(input.request.body, DEFAULT_LIMITS) : input.request.body;
    if (isProtocolError(parsed)) throw parsed;
    const normalized = normalizeRequest(input.request.endpoint, parsed, { signal: input.request.signal, limits: DEFAULT_LIMITS });
    if (!normalized.ok) throw normalized.error;
    const filteredRequest = dependencies.filterRules === undefined ? normalized.request : applyFilterRules(normalized.request, dependencies.filterRules());
    const plannedRequest = dependencies.tokenSaver === undefined ? filteredRequest : applyTokenSaver(filteredRequest, dependencies.tokenSaver());
    const cachePlan = buildCachePlan(plannedRequest);
    const currentRequest = applyCachePlan(plannedRequest, cachePlan);
    normalizedRequest = currentRequest;
    if (dependencies.admission !== undefined && input.authorization.apiKey !== undefined) {
      const admissionBody = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      admissionEstimate = estimateRequestTokens(admissionBody);
      admissionLease = dependencies.admission.acquire(input.authorization.apiKey, admissionEstimate);
    }

    const affinity: AffinityKey = input.authorization.apiKeyId
      ? { namespace: "api_key", value: input.authorization.apiKeyId }
      : { namespace: "trusted_identity", value: input.authorization.trustedIdentity ?? "anonymous" };
    const routePlan = await dependencies.resolveRoutes(currentRequest, affinity);
    const candidates = routePlan.candidates.filter((candidate) => isRouteAllowed(candidate.providerId, candidate.modelId, input.authorization, routePlan.requestedModel));
    resolvedPlan = { ...routePlan, candidates };
    if (resolvedPlan.candidates.length === 0) {
      throw {
        statusCode: 404,
        kind: "model_not_found",
        retryable: false,
        routeScope: "provider",
        source: deriveErrorSource("model_not_found", "provider"),
        sanitizedMessage: routePlan.candidates.length > 0 ? "Model or provider is blocked by the API key ACL" : "No eligible route found",
        retryAt: null,
      } satisfies ProviderCallError;
    }
    emitRequestLog({
      event: "incoming",
      requestId,
      endpoint: input.request.endpoint,
      providerId: resolvedPlan.candidates[0]?.providerId ?? null,
      model: currentRequest.model,
      status: null,
      durationMs: Math.max(0, performance.now() - startedAt),
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      messageCount: currentRequest.messages.length,
      toolCount: currentRequest.tools.length,
      clientName: client.name,
      clientSource: client.source,
      clientIp: input.request.clientIp ?? null,
    });

    const selectedAttempts = new Map<number, RouteAttemptSelection>();
    let successfulSelection: RouteAttemptSelection | null = null;
    let successfulCandidateId: string | null = null;
    const attempt = async (index: number): Promise<ProviderOutput> => {
      const candidate = resolvedPlan?.candidates[index % resolvedPlan.candidates.length];
      if (!candidate) {
        throw {
          statusCode: 503,
          kind: "provider_unavailable",
          retryable: true,
        routeScope: "provider",
        source: deriveErrorSource("provider_unavailable", "provider"),
        sanitizedMessage: "No route candidate available",
          retryAt: null,
        } satisfies ProviderCallError;
      }
      const adapter = dependencies.providers.get(candidate.providerId);
      if (!adapter) {
        throw {
          statusCode: 503,
          kind: "credential_unavailable",
          retryable: false,
        routeScope: "provider",
        source: deriveErrorSource("credential_unavailable", "provider"),
        sanitizedMessage: "Provider is not configured",
        retryAt: null,
        } satisfies ProviderCallError;
      }
      const attemptCleanup = createCleanupStack();
      let handedOff = false;
      try {
        const adapterNeedsCredential = adapter.metadata.credentialKind !== "none";
        const providerRouting = dependencies.getProviderRouting?.(candidate.providerId);
        const affinityKey = input.authorization.apiKeyId ?? input.authorization.trustedIdentity ?? "anonymous";
        const credential = adapterNeedsCredential
          ? await dependencies.accounts.select({
              providerId: candidate.providerId,
              candidates: await dependencies.accountCandidates(candidate.providerId),
              strategy: providerRouting?.strategy ?? "priority",
              affinityKey,
              stickyLimit: providerRouting?.useStickyLimit === true ? providerRouting.stickyLimit : undefined,
              modelId: candidate.modelId,
            })
          : null;
        if (adapterNeedsCredential && credential === null) {
          throw {
            statusCode: 503,
            kind: "credential_unavailable",
            retryable: true,
        routeScope: "account",
        source: deriveErrorSource("credential_unavailable", "account"),
        sanitizedMessage: "No eligible account available",
            retryAt: null,
          } satisfies ProviderCallError;
        }
        if (credential !== null) attemptCleanup.add({ release: async () => dependencies.accounts.release(credential.selection.leaseId) });
        const network = await dependencies.network.select({ providerId: candidate.providerId, affinityKey });
        if (network === null) {
          throw {
            statusCode: 503,
            kind: "network_unavailable",
            retryable: true,
        routeScope: "proxy",
        source: deriveErrorSource("network_unavailable", "proxy"),
        sanitizedMessage: "No outbound network path available",
            retryAt: null,
          } satisfies ProviderCallError;
        }
        attemptCleanup.add({ release: network.selection.release });
        const selected = { accountId: credential?.selection.accountId ?? null, proxyId: network.proxyId } satisfies RouteAttemptSelection;
        selectedAttempts.set(index, selected);
        const wireSurface = wireSurfaceFor(adapter.metadata, adapter.capabilities, currentRequest.sourceSurface);
        if (wireSurface === null) {
          throw {
            statusCode: 400,
            kind: "capability_unsupported",
            retryable: false,
        routeScope: "provider",
        source: deriveErrorSource("capability_unsupported", "provider"),
        sanitizedMessage: `Provider "${candidate.providerId}" cannot translate this protocol surface`,
            retryAt: null,
          } satisfies ProviderCallError;
        }
        const target: RouteTarget = adapter.resolveTarget(candidate.modelId || currentRequest.model, wireSurface);
        let output: ProviderOutput;
        let providerStreamHandedOff = false;
        beginProviderInFlight(candidate.providerId);
        try {
          output = await adapter.call({ target, request: currentRequest, credential: credential?.selection.secret ?? "", network: network.selection, signal: input.request.signal, headers: input.request.headers });
        } catch (error) {
          endProviderInFlight(candidate.providerId);
          throw adapter.mapError(error);
        }
        successfulSelection = selected;
        successfulCandidateId = candidate.id;
        if (output.mode === "stream") {
          handedOff = true;
          providerStreamHandedOff = true;
          return { ...output, events: (async function*() {
            try {
              yield* output.events;
            } finally {
              endProviderInFlight(candidate.providerId);
              await attemptCleanup.run();
            }
          })() };
        }
        if (!providerStreamHandedOff) endProviderInFlight(candidate.providerId);
        await attemptCleanup.run();
        if (output.mode === "non_stream" && target.surface !== currentRequest.sourceSurface) {
          return {
            ...output,
            body: translateNonStreamResponse(output.body, adapter.metadata.protocol, target.surface, currentRequest.sourceSurface),
          };
        }
        return output;
      } finally {
        if (!handedOff) await attemptCleanup.run();
      }
    };

    const output = await recoverCall({
      attempt,
      maxAttempts: Math.min(Math.max(dependencies.maxAttempts ?? 2, 1), 6),
      signal: input.request.signal,
      cleanup,
      mapError: normalizeError,
      onFailure: async (error, index) => {
        const candidates = resolvedPlan?.candidates ?? [];
        const candidate = candidates[index % Math.max(candidates.length, 1)];
        if (candidate) {
          await dependencies.onRouteFailure?.(candidate, error, selectedAttempts.get(index) ?? null);
          const replacement = candidates[index + 1] ?? null;
          if (error.routeScope === "account" || error.routeScope === "proxy") {
            await dependencies.onRouteSwitch?.({ scope: error.routeScope, previousRouteId: candidate.id, replacementRouteId: replacement?.id ?? null, reason: error.kind, occurredAt: new Date().toISOString() });
          }
        }
      },
    });
    const plan = resolvedPlan;
    const providerId = (): string | null => (successfulCandidateId === null ? plan.candidates[0]?.providerId ?? null : plan.candidates.find((candidate) => candidate.id === successfulCandidateId)?.providerId ?? plan.candidates[0]?.providerId ?? null);
    const reportRouteSuccess = async (): Promise<void> => {
      const candidate = successfulCandidateId === null ? null : plan.candidates.find((item) => item.id === successfulCandidateId) ?? null;
      if (candidate !== null) await dependencies.onRouteSuccess?.(candidate, successfulSelection);
    };
    let responseStatus: number | null = null;
    let presentedOutput = output;
    let streamTelemetryPending = false;
    if (output.mode === "non_stream") {
      const usage = output.usage;
      settleAdmission(usage === undefined || usage === null
        ? { inputTokens: admissionEstimate, outputTokens: 0 }
        : { inputTokens: usage.inputTokens ?? admissionEstimate, outputTokens: usage.outputTokens ?? 0 });
    } else {
      streamTelemetryPending = true;
      presentedOutput = {
        ...output,
        events: (async function*() {
          let observedUsage: ProviderUsage | null = null;
          let terminalReason: string | null = null;
          let firstTokenRecorded = false;
          try {
            for await (const event of output.events) {
              if (!firstTokenRecorded && event.type === "text_delta") { telemetry.recordFirstToken(); firstTokenRecorded = true; }
              if (event.type === "usage") observedUsage = event.usage;
              if (event.type === "message_stop") terminalReason = event.reason;
              yield event;
            }
            if (terminalReason !== null && terminalReason !== "error") {
              try { await reportRouteSuccess(); } catch { /* health telemetry must not break a completed stream */ }
            }
          } finally {
            const finalUsage = observedUsage;
            settleAdmission(finalUsage === null
              ? { inputTokens: admissionEstimate, outputTokens: 0 }
              : { inputTokens: finalUsage.inputTokens ?? admissionEstimate, outputTokens: finalUsage.outputTokens ?? 0 });
            decrementInFlight();
            emitRequestLog({
              event: "complete",
              requestId,
              endpoint: input.request.endpoint,
              providerId: providerId(),
              model: normalizedRequest?.model ?? null,
              status: responseStatus,
              durationMs: Math.max(0, performance.now() - startedAt),
              inputTokens: finalUsage?.inputTokens ?? null,
              outputTokens: finalUsage?.outputTokens ?? null,
              cachedTokens: finalUsage?.cacheReadTokens ?? null,
              cacheWriteTokens: finalUsage?.cacheWriteTokens ?? null,
              messageCount: normalizedRequest?.messages.length ?? 0,
              toolCount: normalizedRequest?.tools.length ?? 0,
              clientName: client.name,
              clientSource: client.source,
              clientIp: input.request.clientIp ?? null,
            });
            streamTelemetryPending = false;
            await telemetry.finish({
              statusCode: responseStatus ?? 200,
              errorKind: null,
              usage: finalUsage,
              providerId: providerId(),
              model: normalizedRequest?.model ?? null,
              mode: "stream",
              messageCount: normalizedRequest?.messages.length ?? 0,
              toolCount: normalizedRequest?.tools.length ?? 0,
              imageCount: normalizedRequest?.images.length,
            });
          }
        })(),
      };
    }
    const response = writeResponse(presentedOutput, requestId);
    responseStatus = response.status;
    if (output.mode === "non_stream") {
      emitRequestLog({
        event: "complete",
        requestId,
        endpoint: input.request.endpoint,
        providerId: providerId(),
        model: normalizedRequest.model,
        status: response.status,
        durationMs: Math.max(0, performance.now() - startedAt),
        inputTokens: output.usage?.inputTokens ?? null,
        outputTokens: output.usage?.outputTokens ?? null,
        cachedTokens: output.usage?.cacheReadTokens ?? null,
        cacheWriteTokens: output.usage?.cacheWriteTokens ?? null,
        messageCount: normalizedRequest.messages.length,
        toolCount: normalizedRequest.tools.length,
        clientName: client.name,
        clientSource: client.source,
        clientIp: input.request.clientIp ?? null,
      });
    }
    if (output.mode === "non_stream") {
      await telemetry.finish({
        statusCode: response.status,
        errorKind: null,
        usage: output.usage ?? null,
        providerId: providerId(),
        model: normalizedRequest.model,
        mode: output.mode,
        messageCount: normalizedRequest.messages.length,
        toolCount: normalizedRequest.tools.length,
        imageCount: normalizedRequest.images.length,
      });
      await reportRouteSuccess();
    }
    streamHandedOff = output.mode === "stream";
    return response;
  } catch (error) {
    settleAdmission(null);
    const failure = normalizeError(error);
    const response = writeErrorResponse(failure, requestId);
    emitRequestLog({
      event: "failed",
      requestId,
      endpoint: input.request.endpoint,
      providerId: resolvedPlan?.candidates[0]?.providerId ?? null,
      model: normalizedRequest?.model ?? null,
      status: response.status,
      durationMs: Math.max(0, performance.now() - startedAt),
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      messageCount: normalizedRequest?.messages.length ?? 0,
      toolCount: normalizedRequest?.tools.length ?? 0,
      clientName: client.name,
      clientSource: client.source,
      clientIp: input.request.clientIp ?? null,
    });
    // A caller disconnect is a terminal request outcome, but not a provider
    // failure. Store status 0 (the non-completed sentinel) so it does not
    // inflate usage errors or appear in the completed request history view.
    const telemetryStatus = failure.kind === "client_aborted" ? 0 : response.status;
    const telemetryErrorKind = failure.kind === "client_aborted" ? null : failure.kind;
    await telemetry.finish({
      statusCode: telemetryStatus,
      errorKind: telemetryErrorKind,
      usage: null,
      providerId: resolvedPlan?.candidates[0]?.providerId ?? null,
      model: normalizedRequest?.model ?? null,
      mode: normalizedRequest?.stream ? "stream" : null,
      messageCount: normalizedRequest?.messages.length ?? 0,
      toolCount: normalizedRequest?.tools.length ?? 0,
      imageCount: normalizedRequest?.images.length ?? 0,
    });
    await cleanup.run();
    return response;
  } finally {
    if (!streamHandedOff) decrementInFlight();
  }
}
