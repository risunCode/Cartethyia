/**
 * Shared per-candidate attempt lifecycle for every dispatch route.
 *
 * Admission lease → pool slot → routing reservation, the route-specific
 * upstream operation, then one `completeAttempt` for the attempt's accounting.
 * Retry, backoff, pool-cooldown flagging, and reactive OAuth refresh are one
 * policy here, so the canonical proxy routes and the native Responses-compact
 * route cannot drift. Route-specific behavior arrives as the `prepare` and
 * `attempt` closures; this module never forks retry policy.
 */
import { GatewayError } from "../gateway-error";
import type { ResolvedCredential } from "../../providers/provider-registry";
import { classifyTerminalCategory, fallbackRetryDelayMs, isRetryableFailure, sleep } from "../failure-policy";
import type { OAuthTokenRefresher } from "../../providers/authentication/oauth-refresh-service";
import type { OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import type { AdmissionLease } from "../../security/admission";
import type { RouteCandidate, Reservation, RouteSnapshotService } from "../routing/route-model";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { acquireAttemptLeases, releaseAttemptLeases } from "./leases";
import type { AttemptLeaseSource, AttemptLeases } from "./leases";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ProxyRequestState } from "../request/state";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { flagPoolCooldown } from "../../network/pool-health";
import { completeAttempt, estimatedUsage, type ProviderExchangeCapture } from "./attempt-finalize";
import { shouldCooldownPool, isOAuthCredentialInvalidated } from "./retry-policy";

/** Route-specific preconditions resolved for one candidate before its leases are taken. */
interface PreparedAttempt<TAdapter> {
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
}

/** One candidate attempt with its admission lease, pool slot, and reservation held. */
interface AttemptContext<TAdapter> {
  readonly candidate: RouteCandidate;
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
  readonly leases: AttemptLeases;
  /** Zero-based candidate index; also this attempt's failover count. */
  readonly attemptIndex: number;
  readonly providerCapture: ProviderExchangeCapture;
  /**
   * Hands lease ownership to the value this attempt returns (a streaming
   * response releases its own lease on stream completion/cancel). Without it
   * the loop releases the leases in `finally`.
   */
  retainLeases(): void;
}

/** Collaborators shared by every dispatch route. */
interface AttemptLoopDeps {
  readonly db: CartethyiaDatabase;
  readonly poolSelector?: NetworkPoolSelector;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

interface AttemptLoopInput<TResult, TAdapter> {
  readonly state: ProxyRequestState;
  readonly deps: AttemptLoopDeps;
  readonly leaseSource: AttemptLeaseSource;
  readonly candidates: readonly RouteCandidate[];
  readonly tenantId: string | null;
  /** Strict pool selection rejects direct egress when every pool is at capacity. */
  readonly strictPoolSelection: boolean;
  /** BYOK host for a candidate, when this route validates network bindings. */
  readonly resolveHost?: (candidate: RouteCandidate) => ByokUpstreamHost | undefined;
  readonly prepare: (candidate: RouteCandidate) => Promise<PreparedAttempt<TAdapter>>;
  readonly attempt: (context: AttemptContext<TAdapter>) => Promise<TResult>;
  /** Raised when the candidate list is empty and no attempt ever ran. */
  readonly exhaustedError: GatewayError;
}

/**
 * Shared per-candidate attempt lifecycle for the canonical proxy routes and
 * the native Responses-compact route: admission lease → pool slot → routing
 * reservation, the route-specific upstream operation, then one
 * `completeAttempt` for the attempt's accounting. Retry, backoff,
 * pool-cooldown flagging, and reactive OAuth refresh are one policy here, so
 * the two routes cannot drift.
 */
export async function runAttemptLoop<TResult, TAdapter>(
  input: AttemptLoopInput<TResult, TAdapter>,
): Promise<TResult> {
  const { state, deps, candidates, leaseSource } = input;
  let lastError: unknown = input.exhaustedError;
  const refreshedCandidates = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    let lease: AdmissionLease | undefined;
    let reservation: Reservation | undefined;
    let proxySlot: { poolId: string; release: () => void } | undefined;
    let networkPoolId: string | undefined;
    let bindingEstablished = false;
    let leasesRetained = false;
    let retryDelayMs = 0;
    const providerCapture: ProviderExchangeCapture = {
      request: null,
      response: Promise.resolve(null),
    };
    try {
      if (state.abortController.signal.aborted)
        throw new GatewayError("transport_closed", 499, "request was cancelled");
      const { credential, adapter } = await input.prepare(candidate);
      const host = input.resolveHost?.(candidate);
      // Single attempt-lease manager owns acquisition order (admission →
      // pool slot → reservation) with reverse-order unwind. Assigned only on
      // success, so a mid-acquire throw leaves these undefined for `finally`.
      const attemptLeases = await acquireAttemptLeases(leaseSource, candidate, {
        signal: state.abortController.signal,
        ...(deps.poolSelector ? { poolSelector: deps.poolSelector } : {}),
        ...(deps.networkBindingFactory ? { networkBindingFactory: deps.networkBindingFactory } : {}),
        ...(host ? { host } : {}),
        strictPoolSelection: input.strictPoolSelection,
      });
      lease = attemptLeases.lease;
      reservation = attemptLeases.reservation;
      proxySlot = attemptLeases.proxySlot;
      networkPoolId = attemptLeases.networkPoolId;
      // Downstream error paths gate `commitUsage(estimated)` on this flag so
      // the estimate is only charged once the request truly consumed
      // upstream resources; the lease and reservation are held from here on.
      bindingEstablished = true;
      return await input.attempt({
        candidate,
        credential,
        adapter,
        leases: attemptLeases,
        attemptIndex: index,
        providerCapture,
        retainLeases: () => {
          leasesRetained = true;
        },
      });
    } catch (error) {
      lastError = error;
      const cancelled =
        state.abortController.signal.aborted ||
        (error instanceof GatewayError && error.code === "transport_closed");
      const terminalAttempt =
        cancelled || !isRetryableFailure(error) || index === candidates.length - 1;
      await completeAttempt(state, {
        status: cancelled ? "cancelled" : "failed",
        providerId: candidate.provider_id,
        ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
        ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
        errorCategory: classifyTerminalCategory(error, state.abortController.signal),
        // Same split as the streaming path: a non-GatewayError outcome is ours.
        errorOrigin: error instanceof GatewayError ? error.origin : "cartethyia",
        modelId: candidate.model_id,
        ...(networkPoolId ? { networkPoolId } : {}),
        error,
        ...(lease ? { lease } : {}),
        ...(!cancelled && bindingEstablished
          ? {
              commitUsage: estimatedUsage(
                leaseSource.estimatedInputTokens,
                leaseSource.estimatedOutputTokens,
              ),
            }
          : {}),
        terminal: terminalAttempt,
        tenantId: input.tenantId,
        ingressBody: state.ingressBody,
        responseBody: null,
        providerCapture,
        db: deps.db,
        ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
        ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
      });
      if (networkPoolId && !cancelled && deps.poolSelector && shouldCooldownPool(error)) {
        flagPoolCooldown(deps.poolSelector, deps.db, networkPoolId, candidate.provider_id, error);
      }
      // A 403 can be a deterministic provider policy rejection, not an
      // invalid OAuth credential. Only the evidence-based classifier above
      // may trigger a refresh.
      const candidateKey = `${candidate.provider_id}:${candidate.provider_account_id ?? "global"}:${candidate.model_id}:${candidate.endpoint}`;
      const authInvalidated = isOAuthCredentialInvalidated(error);
      if (
        !cancelled &&
        !refreshedCandidates.has(candidateKey) &&
        authInvalidated &&
        candidate.provider_account_id &&
        deps.oauthRefreshService &&
        deps.resolveOAuthRefresher
      ) {
        const refresher = await deps.resolveOAuthRefresher(candidate.provider_id);
        if (refresher) {
          const fresh = await deps.oauthRefreshService.ensureFreshAccessToken(
            candidate.provider_account_id,
            refresher,
            { force: true },
          );
          if (fresh) {
            refreshedCandidates.add(candidateKey);
            index -= 1;
            continue;
          }
        }
      }
      if (terminalAttempt) {
        metrics.proxy_requests_total.inc(1, { status: cancelled ? "cancelled" : "failed" });
        throw error;
      }
      retryDelayMs = fallbackRetryDelayMs(index);
    } finally {
      if (!leasesRetained)
        await releaseAttemptLeases({ lease, reservation, proxySlot }, leaseSource.routingEngine);
    }
    if (retryDelayMs > 0) await sleep(retryDelayMs, state.abortController.signal);
  }
  metrics.proxy_requests_total.inc(1, { status: "failed" });
  throw lastError;
}
