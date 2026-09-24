// Routing contracts and snapshots.
import { GatewayError } from "../gateway-error";
import { type WireFamily } from "../canonical-model";


export type RoutingRevision = number;

export type CapabilityProfile = Readonly<Record<string, boolean>>;

export interface RouteCandidate {
  readonly provider_id: string;
  readonly model_id: string;
  readonly wire_family: WireFamily;
  readonly endpoint: string;
  readonly capability_profile: CapabilityProfile;
  readonly max_inflight?: number;
  readonly provider_account_id?: string;
  /** Operator-facing label of `provider_account_id` (never the secret), for
   * the Console Log detail line — logs must show a name, not a bare id. */
  readonly provider_account_label?: string;
  /** Every active pool eligible for automatic per-request selection
   * (`NetworkPoolSelector.tryAcquireAvailablePool`) — the dispatch handler
   * picks the least-loaded/non-cooldown pool at request time; there is no
   * admin-pinned single pool. Absent/empty when the provider bypasses the
   * proxy pool entirely (direct dispatch). */
  readonly network_pool_ids?: readonly string[];
  /** True when routing requires a pool even if health filtering leaves none eligible. */
  readonly network_pool_required?: boolean;
  /** `network_pool_ids[i]` → its configured max concurrency, for the
   * selection algorithm's overflow decision. */
  readonly network_pool_limits?: Readonly<Record<string, number>>;
  /** `network_pool_ids[i]` → its routing weight (100 = neutral). Effective
   * capacity scales as `limit * weight / 100`; weight ≤ 0 takes the pool
   * out of selection. */
  readonly network_pool_weights?: Readonly<Record<string, number>>;
  /** Selection strategy for the tenant that owns `network_pool_ids`;
   * `tenantId` names that pool-owning tenant (settings owner and rotation
   * cursor key). Absent = `least_loaded`. */
  readonly network_pool_routing?: PoolRoutingSetting & { readonly tenantId: string };
  /** `null`/`undefined` = globally routable; a tenant id = routable only for that tenant's requests (BYOK). */
  readonly tenant_id?: string | null;
  /** `false` only for a genuinely credential-less provider (e.g. OpenCode
   * Free) dispatched with zero `provider_accounts` rows — the handler skips
   * `resolveCredentialForAccount` and dispatches with a `"none"` credential.
   * Absent/`true` preserves the existing invariant: no account configured
   * means the route is unusable, not silently public. */
  readonly requires_account?: boolean;
}

/**
 * Provider-routing strategies. The runtime tuple is the source: the console's
 * Elysia body schema builds its `t.Literal` union from these values and its
 * operations layer validates direct callers against the same list, so a new
 * strategy cannot land in one and be silently missing from the other.
 */
export const ROUTING_STRATEGIES = ["fallback", "round_robin"] as const;
export type ProviderRoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export interface ProviderRoutingSetting {
  readonly strategy: ProviderRoutingStrategy;
  /** Requests served by one account before round robin advances. */
  readonly rotateCount: number;
  /** Per-account inflight ceiling from the routing panel; `null` = unlimited
   * concurrency per account. */
  readonly maxInflight: number | null;
  readonly enabled: boolean;
  /** When true, this (tenant, provider) dispatches direct — candidates
   * never carry `network_pool_ids` regardless of pool availability. */
  readonly bypassProxy: boolean;
}

/**
 * Providers whose routing defaults to `bypassProxy: true` when no explicit
 * settings row exists yet for a given (tenant, provider) pair. Not a hard
 * lock — an explicit `bypassProxy: false` row overrides this same as any
 * other provider. Picks the starting value for providers that commonly
 * don't work through a plain HTTP/S proxy; route them via a SOCKS5 or
 * proxy pool instead if proxying is required. Consumed by both the
 * console API default (`console/domains/provider-detail.ts`) and the real
 * `transport/routing/route-catalog.ts` so the two never drift.
 *
 * Single owner is the manifest `defaultBypassProxy` flags in
 * `providers/provider-registry.ts`; consumers import it directly from there.
 */

/**
 * Snapshot-level map carrying per-tenant per-provider routing preferences.
 * Outer key is tenantId string, inner key is providerId. Global settings
 * (tenant_id IS NULL) are stored under the sentinel "__global__".
 */
export type ProviderRoutingMap = Readonly<
  Record<string, Readonly<Record<string, ProviderRoutingSetting>>>
>;

/**
 * Pool-group selection strategy for one tenant — the network-pool counterpart
 * to `ProviderRoutingSetting`. `least_loaded` (default) keeps the weighted
 * least-loaded scan with its rotating tie-break; `round_robin` serves
 * `rotateCount` requests per pool before advancing and skips over capacity or
 * cooldown pools the way account failover does.
 */
export interface PoolRoutingSetting {
  readonly strategy: PoolRoutingStrategy;
  /** Requests served by one pool before round robin advances. */
  readonly rotateCount: number;
}

export interface RoutePlan {
  readonly revision: RoutingRevision;
  readonly candidates: readonly RouteCandidate[];
  readonly requested_model: string;
  readonly resolved_model: string;
  readonly provider_id: string;
}

import type { ComboStrategy, PoolRoutingStrategy } from "../../persistence/schema";

export interface ComboDefinition {
  readonly members: readonly string[];
  readonly strategy: ComboStrategy;
}

export interface RouteSnapshot {
  readonly revision: RoutingRevision;
  readonly candidates: readonly RouteCandidate[];
  readonly aliases: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** CLI source→target mappings, enabled only for API keys with the feature scope. */
  readonly cli_aliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly combos: Readonly<Record<string, Readonly<Record<string, ComboDefinition>>>>;
  readonly created_at: number;
  /** Optional per-provider routing preferences keyed by tenant. */
  readonly providerRouting?: ProviderRoutingMap;
  /** Optional per-tenant pool selection strategy (absent = `least_loaded`). */
  readonly poolRouting?: Readonly<Record<string, PoolRoutingSetting>>;
}

export type EligibilityReason =
  | "healthy"
  | "cooldown"
  | "unhealthy"
  | "quota_exhausted"
  | "locked"
  | "disabled"

export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly reason: EligibilityReason;
  readonly candidate: RouteCandidate;
}

export interface Reservation {
  readonly candidate: RouteCandidate;
  readonly lease_id: string;
  readonly expires_at: number;
  readonly acquired_at: number;
}

export interface RouteSnapshotService {
  getSnapshot(): Promise<RouteSnapshot>;
  invalidate(): Promise<RoutingRevision>;
}

/** One admission decision: whether the candidate got a slot, and why not. */
export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly reason?: string;
}

export interface AdmissionController {
  admit(candidate: RouteCandidate): Promise<AdmissionDecision>;
  release(reservation: Reservation): Promise<void>;
}

export function ambiguousModelError(bare: string, owners: string[]): GatewayError {
  return new GatewayError(
    "ambiguous_model",
    400,
    `Model '${bare}' is ambiguous across providers: ${owners.join(", ")}`,
    {
      model: bare,
      owners,
    },
  );
}

/**
 * The requested name resolves to nothing, or no candidate serves its resolved
 * target. `resolved` carries the post-alias/combo target(s) so an alias whose
 * model disappeared from the catalog is diagnosable from the error alone,
 * instead of reading like a typo in the client's own request.
 */
export function modelNotFoundError(requested: string, resolved: readonly string[] = []): GatewayError {
  const targets = resolved.filter((name) => name !== requested);
  const hint = targets.map((name) => `'${name}'`).join(", ");
  return new GatewayError(
    "model_not_found",
    404,
    `Model '${requested}'${targets.length > 0 ? ` (resolved to ${hint})` : ""} not found`,
    {
      model: requested,
      ...(targets.length > 0 ? { resolved_models: targets } : {}),
    },
  );
}

export function capabilityUnsupportedError(capability: string): GatewayError {
  return new GatewayError(
    "capability_unsupported",
    400,
    `Capability '${capability}' not supported`,
    { capability },
  );
}

export function capacityExhaustedError(): GatewayError {
  return new GatewayError("capacity_exhausted", 429, "No capacity available");
}

/**
 * The model exists and is routed, but every account serving it is currently
 * unusable (cooldown / unhealthy / disabled / locked). This is transient and
 * retry-able, so it must NOT surface as `model_not_found` — a 404 tells the
 * client to fix its request when the real fix is to wait or add capacity.
 */
export function accountsUnavailableError(
  requested: string,
  reasons: readonly string[],
  routed: string = requested,
): GatewayError {
  const distinct = [...new Set(reasons)].sort();
  const routeNote = routed === requested ? "" : ` routed to '${routed}'`;
  return new GatewayError(
    "accounts_unavailable",
    503,
    `Model '${requested}'${routeNote} has no available account (${reasons.length} candidate(s) unusable: ${distinct.join(", ")})`,
    { model: requested, routed_model: routed, reasons: distinct, candidate_count: reasons.length },
  );
}



export type SnapshotBuilder = () => Promise<
  Omit<RouteSnapshot, "revision" | "created_at"> & { created_at?: number }
>;

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") deepFreeze(v as unknown as T);
    }
    Object.freeze(obj);
  }
  return obj;
}

export class InMemoryRouteSnapshotService implements RouteSnapshotService {
  private revision: RoutingRevision = 0;
  private snapshot: RouteSnapshot | undefined;
  /**
   * The in-flight build, tagged with the revision it is building.
   *
   * The tag is what keeps a mutation from being lost. A build reads the catalog
   * over ten Postgres round-trips, so a dashboard write can land while one is
   * in flight. Without the tag two things went wrong: a reader that arrived
   * *after* the mutation was handed the still-running pre-mutation build, and
   * that build then overwrote the cache the mutation had just cleared — so the
   * data plane served the old routing until some later write invalidated it
   * again. A build may only be reused by readers at its own revision, and may
   * only populate the cache if no mutation happened while it ran.
   */
  private building: { revision: RoutingRevision; promise: Promise<RouteSnapshot> } | undefined;

  constructor(private readonly builder: SnapshotBuilder) {}

  async getSnapshot(): Promise<RouteSnapshot> {
    if (this.snapshot) return this.snapshot;
    if (this.building && this.building.revision === this.revision) return this.building.promise;
    const revision = this.revision;
    const promise = this.build(revision);
    this.building = { revision, promise };
    try {
      return await promise;
    } finally {
      // Only the build that is still current may clear the slot; a build
      // started after a mutation must not be dropped by an older one finishing.
      if (this.building?.promise === promise) this.building = undefined;
    }
  }


  async invalidate(): Promise<RoutingRevision> {
    this.revision += 1;
    this.snapshot = undefined;
    // Lazy: the next getSnapshot() rebuilds. Dashboard mutations only need
    // the new revision token — they must not pay seven Postgres round-trips
    // inside the mutating request while holding no pool pressure budget.
    return this.revision;
  }

  private async build(revision: RoutingRevision): Promise<RouteSnapshot> {
    const built = await this.builder();
    const providerRouting: ProviderRoutingMap | undefined = built.providerRouting
      ? Object.fromEntries(
          Object.entries(built.providerRouting).map(([tenantId, settings]) => [
            tenantId,
            Object.fromEntries(
              Object.entries(settings).map(([providerId, setting]) => [
                providerId,
                { ...setting, rotateCount: setting.rotateCount ?? 1 },
              ]),
            ),
          ]),
        )
      : undefined;
    // One literal for both routing modes. These used to be two verbatim copies
    // that differed only by the `providerRouting` key, so a snapshot field added
    // to one branch would silently vanish on the other.
    const snapshot = deepFreeze({
      revision,
      candidates: Object.freeze([...built.candidates]) as readonly RouteCandidate[],
      aliases: Object.freeze({ ...built.aliases }),
      ...(built.cli_aliases ? { cli_aliases: Object.freeze({ ...built.cli_aliases }) } : {}),
      combos: Object.freeze({ ...built.combos }),
      ...(providerRouting ? { providerRouting } : {}),
      // Unfrozen copy: deepFreeze must reach the inner per-tenant settings —
      // a pre-frozen record trips its is-frozen guard and skips recursion.
      ...(built.poolRouting ? { poolRouting: { ...built.poolRouting } } : {}),
      created_at: built.created_at ?? Date.now(),
    });
    // A mutation during the build means this snapshot describes a catalog that
    // has already been superseded. Returning it is fine — the caller asked
    // before the mutation — but caching it would strand the data plane on the
    // old routing until the next write.
    if (revision === this.revision) this.snapshot = snapshot;
    return snapshot;
  }
}
