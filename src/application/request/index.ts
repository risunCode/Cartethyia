import { createCleanupStack, sanitizeMessage, deriveErrorSource, type ApplicationErrorKind, type ProviderCallError } from "../contracts";
import type { PresentedProxyResponse } from "../contracts";
import type { Adapter, ProviderOutput, Surface, ProviderUsage, RequestRoutingMetadata, TranslationDiagnostic, RouteTarget, StreamEvent, WebSearchFallback } from "../contracts";
import type { AccountCandidate, AffinityKey, RouteCandidate, RouteSwitch } from "../contracts";
import type { ProxyRequest, RunProxyRequestInput } from "../contracts";
import type { ClientIdentity } from "../contracts";
import { detectClientFormat, clientIdentityForProfile } from "../../open-sse/translate/detection";
import type { RequestTelemetryHandle, TelemetryWriter } from "../contracts";
import { isRouteAllowed } from "../../security/access";
import { CredentialSelector } from "../auth";
import { NetworkSelector } from "../../traffic";
import { beginProviderInFlight, decrementInFlight, endProviderInFlight, incrementInFlight } from "../../traffic/in-flight";
import type { ApiKeyAdmission, AdmissionLease, AdmissionUsage } from "../../traffic/admission";
import type { ApiKeyPublic } from "../../storage";
import { isProviderCallError, recoverCall } from "../../open-sse/handlers/recovery";
import { resolveModelWireSurface } from "../../open-sse/translate";
import { findCacheBreakpoint } from "../cache";
import { ProtocolCodecError } from "../../open-sse/translate/errors";
import { writeErrorResponse, writeResponse } from "../../open-sse/handlers";
import type { TokenSaverConfig } from "../../open-sse/rtk";
import { createRouteAttempt, createRouteAttemptState, getRouteAttemptSelection, getTranslationDiagnostics, getSelectedAttempt, getSelectedCandidateId, getSelectedCredentialKind, getSuccessfulCandidateId, getNextCandidateId, hasNextCandidate, clearAccountCandidates, markAccountRetry, markReactiveRefresh } from "./route-attempt";
import type { HeadroomOutcome } from "../../open-sse/rtk/headroom";
import type { FilterRuleConfig } from "../filter-rules";
import { prepareProxyRequest } from "./prepare";
import { createPayloadCapture } from "./payload-capture";


function admissionInputTokens(usage: ProviderUsage, fallback: number): number {
  if (usage.inputTokens === null) return fallback;
  return Math.max(0, Math.floor(usage.inputTokens) + Math.floor(usage.cacheReadTokens ?? 0) + Math.floor(usage.cacheWriteTokens ?? 0));
}
export interface ProxyRoutePlan {
  readonly affinity: AffinityKey;
  readonly candidates: readonly RouteCandidate[];
  readonly requestedModel?: string;
  readonly unsupportedReason?: string;
  readonly webSearch?: boolean;
  readonly webSearchPassthrough?: boolean;
  readonly maxAttempts?: number;
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
  readonly errorKind: ApplicationErrorKind | null;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly clientName: string;
  readonly clientSource: string;
  readonly clientIp: string | null;
}

export interface ProxyRequestDependencies {
  readonly providers: { get(providerId: string): Adapter | undefined };
  readonly accounts: CredentialSelector;
  readonly network: NetworkSelector;
  readonly telemetry: TelemetryWriter;
  readonly resolveRoutes: (request: ProxyRequest, affinity: AffinityKey, client: ClientIdentity) => Promise<ProxyRoutePlan>;
  readonly accountCandidates: (providerId: string) => Promise<readonly AccountCandidate[]>;
  readonly getProviderRouting?: (providerId: string) => { readonly strategy: "priority" | "round-robin"; readonly stickyLimit: number; readonly useStickyLimit: boolean };
  readonly onRouteFailure?: (candidate: RouteCandidate, error: ProviderCallError, selected: RouteAttemptSelection | null) => Promise<void>;
  readonly onRouteSuccess?: (candidate: RouteCandidate, selected: RouteAttemptSelection | null) => Promise<void>;
  readonly onRouteSwitch?: (event: RouteSwitch) => Promise<void>;
  readonly onRequestLog?: (event: ProxyRequestLogEvent) => void;
  readonly admission?: ApiKeyAdmission;
  readonly maxAttempts?: number;
  readonly tokenSaver?: () => TokenSaverConfig;
  readonly headroom?: (request: ProxyRequest) => Promise<HeadroomOutcome>;
  readonly filterRules?: () => FilterRuleConfig;
  readonly createPayloadCapture?: (requestId: string) => { save(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number }): void } | null;
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
/** Codex ChatGPT transport uses the direct path unless explicitly overridden. */
const CODEX_PROXY_ENABLED = process.env.CARTETHYIA_CODEX_PROXY === "true";
function selectWireSurface(adapter: Adapter, candidate: RouteCandidate, request: ProxyRequest): Surface | null {
  const model = adapter.models.get(candidate.modelId);
  return resolveModelWireSurface(adapter.metadata, adapter.capabilities, model?.capabilities ?? null, request.sourceSurface);
}

function normalizeError(error: unknown): ProviderCallError {
  if (isProviderCallError(error)) return error;
  if (error instanceof ProtocolCodecError) return error.toProviderCallError(sanitizeMessage(error.message));
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
  const client = clientIdentityForProfile(detectClientFormat(input.request.endpoint, input.request.surface, input.request.headers, input.request.body).profile);
  const telemetry = telemetryStart(input.request, requestId, client, input.authorization, dependencies.telemetry);
  const captureSink = dependencies.createPayloadCapture?.(requestId) ?? null;
  const capture = captureSink === null ? null : createPayloadCapture(requestId, captureSink);
  if (capture !== null) capture.request(input.request.body);
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
  let normalizedRequest: ProxyRequest | undefined;
  let translationDiagnostics: readonly TranslationDiagnostic[] = [];
  let resolvedPlan: ProxyRoutePlan | undefined;
  const routeAttemptState = createRouteAttemptState();

  const webSearchFallbacks: WebSearchFallback[] = [];
  let streamHandedOff = false;
  const routeMetadata = (errorMessage: string | null = null): RequestRoutingMetadata => {
    const request = normalizedRequest;
    const plan = resolvedPlan;
    const successfulCandidateId = getSuccessfulCandidateId(routeAttemptState);
    const candidate = successfulCandidateId === null
      ? plan?.candidates[0] ?? null
      : plan?.candidates.find((item) => item.id === successfulCandidateId) ?? plan?.candidates[0] ?? null;
    const adapter = candidate === null ? undefined : dependencies.providers.get(candidate.providerId);
    let wireSurface: Surface | null = null;
    let upstreamModel: string | null = candidate?.modelId ?? null;
    if (adapter !== undefined && candidate !== null && request !== undefined) {
      wireSurface = selectWireSurface(adapter, candidate, request);
      if (wireSurface !== null) {
        try {
          upstreamModel = adapter.resolveTarget(candidate.modelId, wireSurface).upstreamModelId;
        } catch {
          // Route metadata must never change the request outcome.
        }
      }
    }
    return {
      requestedModel: request?.model ?? null,
      mappedModel: plan?.requestedModel ?? request?.model ?? null,
      upstreamModel,
      wireSurface,
      errorMessage,
      cacheKeyPresent: request?.cacheKey !== undefined,
      cacheBreakpointPresent: request === undefined ? false : findCacheBreakpoint(request) !== null,
      ...(candidate?.searchRoute === undefined
        ? {}
        : { webSearchRoute: candidate.searchRoute, webSearchPassthrough: candidate.searchRoute === "passthrough" }),
      ...(webSearchFallbacks.length === 0 ? {} : { webSearchFallbacks: [...webSearchFallbacks] }),
      ...((translationDiagnostics.length === 0 && getTranslationDiagnostics(routeAttemptState).length === 0) ? {} : { translationDiagnostics: [...translationDiagnostics, ...getTranslationDiagnostics(routeAttemptState)].slice(0, 32) }),
    };
  };
  const settleAdmission = (usage: AdmissionUsage | null): void => {
    if (admissionSettled || admissionLease === null) return;
    admissionSettled = true;
    if (usage === null) admissionLease.release();
    else admissionLease.commit(usage);
  };

  incrementInFlight();
  try {
    const prepared = await prepareProxyRequest(input, dependencies);
    const currentRequest = prepared.request;
    normalizedRequest = currentRequest;
    translationDiagnostics = prepared.translationDiagnostics;
    admissionEstimate = prepared.admissionEstimate;
    if (dependencies.admission !== undefined && input.authorization.apiKey !== undefined) {
      admissionLease = dependencies.admission.acquire(input.authorization.apiKey, admissionEstimate);
    }

    const affinity: AffinityKey = input.authorization.apiKeyId
      ? { namespace: "api_key", value: input.authorization.apiKeyId }
      : { namespace: "trusted_identity", value: input.authorization.trustedIdentity ?? "anonymous" };
    const routePlan = await dependencies.resolveRoutes(currentRequest, affinity, client);
    const candidates = routePlan.candidates.filter((candidate) => isRouteAllowed(candidate.providerId, candidate.modelId, input.authorization, routePlan.requestedModel));
    resolvedPlan = { ...routePlan, candidates };
    if (resolvedPlan.candidates.length === 0) {
      const unsupported = routePlan.unsupportedReason !== undefined;
      const kind = unsupported ? "capability_unsupported" : "model_not_found";
      throw {
        statusCode: unsupported ? 400 : 404,
        kind,
        retryable: false,
        routeScope: "provider",
        source: deriveErrorSource(kind, "provider"),
        sanitizedMessage: routePlan.candidates.length > 0
          ? "Model or provider is blocked by the API key ACL"
          : routePlan.unsupportedReason ?? "No eligible route found",
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
      errorKind: null,
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

    const attempt = createRouteAttempt({
      input,
      dependencies,
      request: currentRequest,
      plan: resolvedPlan,
      capture,
      state: routeAttemptState,
    });
    let reactiveRetryReady = false;

    const output = await recoverCall({
      attempt,
      maxAttempts: Math.min(
        Math.max(
          resolvedPlan.webSearch === true ? resolvedPlan.maxAttempts ?? 2 : dependencies.maxAttempts ?? 2,
          1,
        ),
        6,
      ),
      signal: input.request.signal,
      cleanup,
      mapError: normalizeError,
      onFailure: async (error, index) => {
        const candidates = resolvedPlan?.candidates ?? [];
        const selectedCandidateId = getSelectedCandidateId(routeAttemptState, index);
        const candidate = selectedCandidateId === null ? null : candidates.find((item) => item.id === selectedCandidateId) ?? null;
        const selected = getSelectedAttempt(routeAttemptState, index);
        if (candidate !== null) {
          await dependencies.onRouteFailure?.(candidate, error, selected);
          if (error.routeScope === "account") {
            clearAccountCandidates(routeAttemptState, candidate.providerId);
          }
        }
        const authFailure = (error.statusCode === 401 || error.statusCode === 403) && (error.kind === "authentication_failed" || error.kind === "authorization_denied");
        const accountId = selected?.accountId ?? null;
        if (candidate !== null && error.routeScope === "account" && !authFailure) {
          markAccountRetry(routeAttemptState, candidate.id);
          return;
        }
        const canReact = authFailure && candidate !== null && accountId !== null && getSelectedCredentialKind(routeAttemptState, index) === "oauth" && markReactiveRefresh(routeAttemptState, accountId, candidate.id);
        if (canReact) {
          try {
            await dependencies.accounts.forceRefresh(accountId);
            reactiveRetryReady = true;
          } catch {
            reactiveRetryReady = false;
          }
          return;
        }
        const replacementId = resolvedPlan === undefined ? null : getNextCandidateId(routeAttemptState, resolvedPlan);
        const replacement = replacementId === null ? null : candidates.find((item) => item.id === replacementId) ?? null;
        if (candidate !== null && resolvedPlan?.webSearch === true && replacement?.id !== candidate.id) {
          webSearchFallbacks.push({ previousRouteId: candidate.id, replacementRouteId: replacement?.id ?? null, reason: error.kind });
        }
        if (candidate !== null && (error.routeScope === "account" || error.routeScope === "proxy")) {
          await dependencies.onRouteSwitch?.({ scope: error.routeScope, previousRouteId: candidate.id, replacementRouteId: replacement?.id ?? null, reason: error.kind, occurredAt: new Date().toISOString() });
        }
      },
      shouldRetry: (error) => {
        const authFailure = (error.statusCode === 401 || error.statusCode === 403) && (error.kind === "authentication_failed" || error.kind === "authorization_denied");
        if (reactiveRetryReady && authFailure) {
          reactiveRetryReady = false;
          return true;
        }
        if (authFailure && resolvedPlan !== undefined && hasNextCandidate(routeAttemptState, resolvedPlan)) return true;
        if (resolvedPlan?.webSearch === true && error.kind === "capability_unsupported" && hasNextCandidate(routeAttemptState, resolvedPlan)) return true;
        return error.retryable && !input.request.signal.aborted;
      },
    });
    const plan = resolvedPlan;
    const providerId = (): string | null => {
      const successfulCandidateId = getSuccessfulCandidateId(routeAttemptState);
      return successfulCandidateId === null ? plan.candidates[0]?.providerId ?? null : plan.candidates.find((candidate) => candidate.id === successfulCandidateId)?.providerId ?? plan.candidates[0]?.providerId ?? null;
    };
    const reportRouteSuccess = async (): Promise<void> => {
      const successfulCandidateId = getSuccessfulCandidateId(routeAttemptState);
      const candidate = successfulCandidateId === null ? null : plan.candidates.find((item) => item.id === successfulCandidateId) ?? null;
      if (candidate !== null) await dependencies.onRouteSuccess?.(candidate, getRouteAttemptSelection(routeAttemptState));
    };
    let responseStatus: number | null = null;
    let presentedOutput = output;
    const clientStreamEvents: StreamEvent[] = [];
    if (output.mode === "non_stream") {
      const usage = output.usage;
      settleAdmission(usage === undefined || usage === null
        ? { inputTokens: admissionEstimate, outputTokens: 0 }
        : { inputTokens: admissionInputTokens(usage, admissionEstimate), outputTokens: usage.outputTokens ?? 0 });
    } else {
      presentedOutput = {
        ...output,
        events: (async function*() {
          let observedUsage: ProviderUsage | null = null;
          let terminalReason: string | null = null;
          let streamErrorKind: ApplicationErrorKind | null = null;
          let streamErrorMessage: string | null = null;
          let firstTokenRecorded = false;
          try {
            for await (const event of output.events) {
              if (clientStreamEvents.length < 128) clientStreamEvents.push(event);
              if (!firstTokenRecorded && event.type === "text_delta") { telemetry.recordFirstToken(); firstTokenRecorded = true; }
              if (event.type === "usage") observedUsage = event.usage;
              if (event.type === "message_stop") {
                terminalReason = event.reason;
                streamErrorKind = event.error?.kind ?? null;
                streamErrorMessage = event.error?.message ?? null;
              }
              yield event;
            }
            if (terminalReason !== null && terminalReason !== "error") {
              try { await reportRouteSuccess(); } catch { /* health telemetry must not break a completed stream */ }
            }
          } finally {
            const finalUsage = observedUsage;
            settleAdmission(finalUsage === null
              ? { inputTokens: admissionEstimate, outputTokens: 0 }
              : { inputTokens: admissionInputTokens(finalUsage, admissionEstimate), outputTokens: finalUsage.outputTokens ?? 0 });
            decrementInFlight();
            emitRequestLog({
              event: "complete",
              requestId,
              endpoint: input.request.endpoint,
              providerId: providerId(),
              errorKind: streamErrorKind,
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
            if (capture !== null) {
              capture.response({ mode: "stream", events: clientStreamEvents });
            }
            await telemetry.finish({
              statusCode: responseStatus ?? 200,
              errorKind: streamErrorKind,
              usage: finalUsage,
              providerId: providerId(),
              model: normalizedRequest?.model ?? null,
              mode: "stream",
              messageCount: normalizedRequest?.messages.length ?? 0,
              toolCount: normalizedRequest?.tools.length ?? 0,
              imageCount: normalizedRequest?.images.length,
              routing: routeMetadata(streamErrorMessage),
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
        errorKind: null,
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
      capture?.response(response.body.mode === "json" ? response.body.value : null);
      await capture?.settle();
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
        routing: routeMetadata(),
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
      errorKind: failure.kind,
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
    capture?.response(response.body.mode === "json" ? response.body.value : null);
    await capture?.settle();
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
      routing: routeMetadata(failure.sanitizedMessage),
    });
    await cleanup.run();
    return response;
  } finally {
    if (!streamHandedOff) decrementInFlight();
  }
}
