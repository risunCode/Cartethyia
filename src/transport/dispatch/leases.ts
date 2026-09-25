import { GatewayError } from "../gateway-error";
import type { AdmissionLease, ApiKeyAdmissionService } from "../../security/admission";
import type { ApiKeyAuthorizationSnapshot } from "../../security/api-key-auth";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import type { PoolRotation, PoolSelectionFailure } from "../../network/pool/selector";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { RouteCandidate as RouteCandidate, Reservation, RoutePlan } from "../routing/route-model";
import type { RoutingEngine } from "../routing/router";

export interface AttemptLeases {
  readonly lease: AdmissionLease;
  readonly reservation: Reservation;
  readonly proxySlot?: { poolId: string; release: () => void };
  readonly networkPoolId?: string;
}

export interface AttemptLeaseSource {
  readonly admissionService: ApiKeyAdmissionService;
  readonly routingEngine: RoutingEngine;
  readonly plan: RoutePlan;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly authorizationSnapshot: ApiKeyAuthorizationSnapshot;
}

async function acquirePoolSlot(
  candidate: RouteCandidate,
  source: AttemptLeaseSource,
  poolSelector: NetworkPoolSelector | undefined,
  strictPoolSelection: boolean,
): Promise<{ poolId: string; release: () => void } | undefined> {
  let poolIds = candidate.network_pool_ids;
  let limits = candidate.network_pool_limits;
  let weights = candidate.network_pool_weights;
  let routing = candidate.network_pool_routing;
  if (!poolIds?.length && !candidate.network_pool_required && source.plan.candidates) {
    const sibling = source.plan.candidates.find(
      (c) =>
        c.provider_id === candidate.provider_id &&
        c.tenant_id === candidate.tenant_id &&
        c.network_pool_ids?.length,
    );
    if (sibling?.network_pool_ids?.length) {
      poolIds = sibling.network_pool_ids;
      limits = sibling.network_pool_limits;
      weights = sibling.network_pool_weights;
      routing = sibling.network_pool_routing;
    }
  }
  // Round-robin rotation rides the strategy the snapshot attached to the
  // candidate (the pool-owning tenant scopes the cursor); absent strategy or
  // `least_loaded` keeps the default weighted least-loaded scan.
  const rotation: PoolRotation | undefined =
    routing?.strategy === "round_robin"
      ? { key: routing.tenantId, rotateCount: routing.rotateCount }
      : undefined;

  if (!poolIds?.length || !poolSelector) {
    if (candidate.network_pool_required && strictPoolSelection) {
      throw new GatewayError(
        "proxy_pool_unhealthy",
        503,
        "All configured proxy pools are unhealthy or disabled.",
        { reason: "no_healthy_pool" },
        "network",
      );
    }
    return undefined;
  }
  if (!strictPoolSelection) {
    return poolSelector.tryAcquireAvailablePool(
      poolIds,
      candidate.provider_id,
      limits,
      weights,
      rotation,
    );
  }
  let acquiredSlot: { poolId: string; release: () => void } | undefined;
  try {
    acquiredSlot = await poolSelector.tryAcquireAvailablePool(
      poolIds,
      candidate.provider_id,
      limits,
      weights,
      rotation,
    );
  } catch {
    throw new GatewayError(
      "proxy_pool_unavailable",
      503,
      "No active proxy pool is available because coordination is unavailable.",
      { reason: "coordination_unavailable" },
      "network",
    );
  }
  if (acquiredSlot) return acquiredSlot;
  const poolDetails = poolIds.map((poolId) => {
    const maxInflight = limits?.[poolId] ?? 10;
    const weight = weights?.[poolId] ?? 100;
    const currentInflight =
      typeof poolSelector.getInflight === "function" ? poolSelector.getInflight(poolId) : 0;
    return {
      poolId,
      maxInflight,
      weight,
      currentInflight,
      available: Math.max(0, maxInflight - currentInflight),
    };
  });
  const failure: PoolSelectionFailure =
    typeof poolSelector.getSelectionFailure === "function"
      ? await poolSelector.getSelectionFailure(
          poolIds,
          candidate.provider_id,
          limits,
          weights,
        )
      : { reason: "at_capacity" as const, pools: poolDetails };
  const code =
    failure.reason === "at_capacity"
      ? "proxy_pool_capacity_exceeded"
      : failure.reason === "cooldown"
        ? "proxy_pool_cooldown"
        : "proxy_pool_unavailable";
  const status = failure.reason === "at_capacity" ? 429 : 503;
  const message =
    failure.reason === "at_capacity"
      ? "Proxy Pool Capacity Exceeded. All configured proxy pools are at their current capacity; please wait and retry."
      : failure.reason === "cooldown"
        ? "All configured proxy pools are cooling down for this provider."
        : "No active proxy pool is available for this tenant and provider.";
  throw new GatewayError(code, status, message, {
    pools: failure.pools,
    // Only measured evidence: a cooldown's real reset instant. The
    // `at_capacity` 429 carries no hint at all — how long until a slot frees is
    // not known here — so it keeps the documented one-second floor the error
    // normalization applies to every evidence-free 429, rather than this path
    // asserting a fabricated 1000ms that only happened to match it.
    ...(failure.retryAt ? { retryAt: new Date(failure.retryAt).toISOString() } : {}),
  });
}

export async function acquireAttemptLeases(
  source: AttemptLeaseSource,
  candidate: RouteCandidate,
  input: {
    readonly signal: AbortSignal;
    readonly poolSelector?: NetworkPoolSelector;
    readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
    readonly host?: ByokUpstreamHost;
    readonly strictPoolSelection: boolean;
  },
): Promise<AttemptLeases> {
  const partial: {
    lease?: AdmissionLease;
    reservation?: Reservation;
    proxySlot?: { poolId: string; release: () => void };
  } = {};
  try {
    partial.lease = await source.admissionService.admit({
      authorization: source.authorizationSnapshot,
      targetProvider: candidate.provider_id,
      targetModel: candidate.model_id,
      // The caller-facing name (alias/combo) this candidate was resolved
      // from. Admission authorizes it too, so an allowlisted alias works.
      requestedModel: source.plan.requested_model,
      estimatedInputTokens: source.estimatedInputTokens,
      estimatedOutputTokens: source.estimatedOutputTokens,
      signal: input.signal,
    });
    // Pre-dispatch fail-closed check for configurable (BYOK) upstreams: a host
    // whose advertised addresses fail the SSRF policy must be rejected before
    // any egress is attempted. The resolved destination is deliberately
    // discarded — the validated outbound fetch re-resolves and pins the
    // address per request, so storing it here would only pin a stale answer.
    if (input.networkBindingFactory && input.host)
      await input.networkBindingFactory.resolve(input.host.hostname, input.signal, input.host.port);
    const slot = await acquirePoolSlot(candidate, source, input.poolSelector, input.strictPoolSelection);
    if (slot) partial.proxySlot = slot;
    if (input.strictPoolSelection && input.signal.aborted)
      throw new GatewayError("transport_closed", 499, "request was cancelled");
    partial.reservation = await source.routingEngine.reserve({
      ...source.plan,
      candidates: [candidate],
    });
    return {
      lease: partial.lease,
      reservation: partial.reservation,
      ...(partial.proxySlot ? { proxySlot: partial.proxySlot } : {}),
      ...(partial.proxySlot ? { networkPoolId: partial.proxySlot.poolId } : {}),
    };
  } catch (error) {
    await releaseAttemptLeases(partial, source.routingEngine);
    throw error;
  }
}

export async function releaseAttemptLeases(
  leases: {
    readonly lease?: AdmissionLease | undefined;
    readonly reservation?: Reservation | undefined;
    readonly proxySlot?: { release: () => void } | undefined;
  },
  routingEngine: Pick<RoutingEngine, "release">,
): Promise<void> {
  leases.proxySlot?.release();
  await Promise.allSettled([
    ...(leases.lease ? [leases.lease.release()] : []),
    ...(leases.reservation ? [routingEngine.release(leases.reservation)] : []),
  ]);
}