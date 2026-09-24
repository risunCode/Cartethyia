// Routing admission, reservations, and route planning.
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import { metrics } from "../../observability/metrics";
import {
  accountsUnavailableError,
  ambiguousModelError,
  capacityExhaustedError,
  capabilityUnsupportedError,
  modelNotFoundError,
  type AdmissionController,
  type AdmissionDecision,
  type ComboDefinition,
  type ProviderRoutingSetting,
  type Reservation,
  type RouteCandidate,
  type RoutePlan,
  type EligibilityDecision,
  type RouteSnapshot,
  type RoutingRevision,
} from "./route-model";
import { candidateSupportsRequest, type RequiredCapability } from "../translation/capabilities";


/**
 * Admission bucket identity. Account-scoped so each account of a provider
 * enforces its own concurrency ceiling; candidates without an account id
 * (credential-less providers) fall back to the provider:model bucket.
 */
function admissionKey(candidate: RouteCandidate): string {
  const base = `${candidate.provider_id}:${candidate.model_id}`;
  return candidate.provider_account_id === undefined
    ? base
    : `${base}:${candidate.provider_account_id}`;
}

/**
 * What one candidate's configured ceiling tells admission to do, before any
 * back end has looked at its counter.
 */
type AdmissionDirective =
  | { readonly kind: "unlimited" }
  | { readonly kind: "reject" }
  | { readonly kind: "bounded"; readonly limit: number };

/**
 * The one admission policy, shared by both controllers.
 *
 * Both back ends must reach the same three-way decision for one candidate:
 * no configured ceiling (account and routing panel both empty) means the
 * account is UNLIMITED — still counted, so inflight stays observable, but
 * never rejected; a non-positive ceiling is a configured zero, so every
 * request is rejected; and reaching the ceiling rejects. Only the comparison
 * itself is back-end specific (a `Map` read here, an atomic Lua `GET`/`INCR`
 * for Redis), so the decision and the rejection it produces live in one
 * place and the two deployments cannot report different telemetry for the
 * same input.
 */
function admissionDirective(candidate: RouteCandidate): AdmissionDirective {
  const limit = candidate.max_inflight;
  if (limit === undefined) return { kind: "unlimited" };
  if (limit <= 0) return { kind: "reject" };
  return { kind: "bounded", limit };
}

/** The one shape of an admission rejection: the metric, then the decision. */
function capacityRejected(): AdmissionDecision {
  metrics.proxy_admission_total.inc(1, { reason: "provider_capacity" });
  return { admitted: false, reason: "capacity_exhausted" };
}

export class InMemoryAdmissionController implements AdmissionController {
  private inflight = new Map<string, number>();
  async admit(candidate: RouteCandidate): Promise<AdmissionDecision> {
    // Bucket per ACCOUNT, not per provider:model. A provider with N accounts
    // holds N independent ceilings, so total inflight scales with the account
    // count instead of every account sharing one pool-wide bucket (which made
    // round-robin look "sticky": account 2+ was always admitted-rejected).
    const key = admissionKey(candidate);
    const directive = admissionDirective(candidate);
    if (directive.kind === "reject") return capacityRejected();
    const cur = this.inflight.get(key) ?? 0;
    if (directive.kind === "bounded" && cur >= directive.limit) return capacityRejected();
    this.inflight.set(key, cur + 1);
    return { admitted: true };
  }

  async release(reservation: Reservation): Promise<void> {
    const key = admissionKey(reservation.candidate);
    const cur = this.inflight.get(key) ?? 1;
    this.inflight.set(key, Math.max(0, cur - 1));
  }
}

/**
 * Redis-backed admission controller for routing inflight. Replaces the
 * in-memory controller so multi-instance deployments enforce one shared
 * per-account inflight bucket — mirroring the in-memory controller's
 * account-scoped ceiling. A 60s TTL self-heals crash-orphaned increments
 * without the full lease machinery (over-inflating a route slot is bounded
 * and less harmful than corrupting quota counters).
 */
const INFLIGHT_TTL_SECONDS = 60;

const ADMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then return 0 end
local next = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return next
`;

/** Counts an admission without any ceiling (unlimited account). */
const UNLIMITED_ADMIT_SCRIPT = `
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return 1
`;
const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
local next = redis.call('DECR', KEYS[1])
if next <= 0 then redis.call('DEL', KEYS[1]) end
return next
`;

export class RedisAdmissionController implements AdmissionController {
  constructor(private readonly redis: RedisClient) {}

  private key(candidate: RouteCandidate): string {
    return `admission:inflight:${admissionKey(candidate)}`;
  }

  async admit(candidate: RouteCandidate): Promise<AdmissionDecision> {
    const directive = admissionDirective(candidate);
    if (directive.kind === "reject") return capacityRejected();
    // The unlimited path counts with the TTL self-heal but never compares
    // against a ceiling, so no limit argument ever reaches the ceiling script.
    const result = await redisEvalNumber(
      this.redis,
      directive.kind === "unlimited" ? UNLIMITED_ADMIT_SCRIPT : ADMIT_SCRIPT,
      1,
      this.key(candidate),
      ...(directive.kind === "unlimited"
        ? [INFLIGHT_TTL_SECONDS]
        : [directive.limit, INFLIGHT_TTL_SECONDS]),
    );
    if (directive.kind === "bounded" && result === 0) return capacityRejected();
    return { admitted: true };
  }

  async release(reservation: Reservation): Promise<void> {
    await redisEvalNumber(this.redis, RELEASE_SCRIPT, 1, this.key(reservation.candidate));
  }
}


function parseModel(model: string): { providerId: string | null; bare: string } {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerId: null, bare: model };
  return { providerId: model.slice(0, slash), bare: model.slice(slash + 1) };
}

function candidateMatches(candidate: RouteCandidate, model: string): boolean {
  const parsed = parseModel(model);
  if (parsed.providerId === null) return candidate.model_id === parsed.bare;
  return candidate.model_id === parsed.bare && candidate.provider_id === parsed.providerId;
}

/**
 * Normalizes a requested model name before alias lookup. Coding-agent CLIs
 * version their model ids with variant suffixes (`claude-opus-5[1m]`,
 * effort tags, …) that must never each become a mapping row. Normalization
 * is a pure lookup fallback — verbatim match always wins, and an
 * unrecognized name still resolves to itself (then fails downstream as
 * `model_not_found`, exactly like today).
 */
function normalizeAliasKey(requested: string, aliasMap: Record<string, string> | undefined): string {
  if (!aliasMap || aliasMap[requested] !== undefined) return requested;
  // 1. Strip a trailing `[...]` variant (`claude-opus-5[1m]` → `claude-opus-5`).
  let base = requested;
  const bracket = requested.indexOf("[");
  if (bracket > 0) {
    base = requested.slice(0, bracket);
    if (aliasMap[base] !== undefined) return base;
  }
  // 2. Family-slot fallback: `claude-<slot>-…` resolves through the slot
  // alias (`claude-opus-5` → `opus`, `claude-opus` → `opus`) so a full model
  // id honors the same mapping as the short slot name without per-variant
  // rows. Only fires when the full name has no mapping of its own.
  if (base.startsWith("claude-")) {
    const rest = base.slice("claude-".length);
    if (aliasMap[rest] !== undefined) return rest;
    const dash = rest.indexOf("-");
    if (dash > 0) {
      const slot = rest.slice(0, dash);
      if (aliasMap[slot] !== undefined) return slot;
    }
  }
  return base;
}

/**
 * Resolves one requested name to its alias target for pre-routing policy
 * checks. CLI mappings are opt-in per API key; ordinary tenant aliases always
 * remain available.
 */
export function resolveAliasTarget(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  requested: string,
  allowCliMappings = false,
): string {
  try {
    return resolveAlias(requested, snapshot, tenantId, allowCliMappings).model;
  } catch {
    return requested;
  }
}

function aliasMapFor(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings: boolean,
): Record<string, string> | undefined {
  if (!tenantId) return undefined;
  const aliases = snapshot.aliases?.[tenantId];
  const cliAliases = allowCliMappings ? snapshot.cli_aliases?.[tenantId] : undefined;
  if (!aliases && !cliAliases) return undefined;
  return { ...(aliases ?? {}), ...(cliAliases ?? {}) };
}

function resolveAlias(
  requested: string,
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings = false,
): { model: string; chain: readonly string[] } {
  const aliasMap = aliasMapFor(snapshot, tenantId, allowCliMappings);
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = normalizeAliasKey(requested, aliasMap);
  while (aliasMap?.[current] !== undefined) {
    if (seen.has(current))
      throw new Error(`routing alias cycle: ${[...chain, current].join(" -> ")}`);
    if (chain.length >= 16)
      throw new Error(`routing alias depth exceeded: ${[...chain, current].join(" -> ")}`);
    const target = aliasMap[current];
    if (target === undefined) break;
    seen.add(current);
    chain.push(current);
    current = target;
  }
  return { model: current, chain };
}

/**
 * Shared eligibility evaluator used by live routing, console diagnostics,
 * manual tests, and probes. No path bypasses it.
 */
export class EligibilityEvaluator {
  evaluate(candidate: RouteCandidate): EligibilityDecision {
    const state = candidate as RouteCandidate & {
      readonly health_status?: string;
      readonly account_locked?: boolean;
      readonly locked?: boolean;
    };
    if (state.account_locked || state.locked)
      return { eligible: false, reason: "locked", candidate };
    if (state.health_status === "cooldown")
      return { eligible: false, reason: "cooldown", candidate };
    if (state.health_status === "disabled")
      return { eligible: false, reason: "disabled", candidate };
    if (state.health_status === "unhealthy" || state.health_status === "degraded")
      return { eligible: false, reason: "unhealthy", candidate };
    return { eligible: true, reason: "healthy", candidate };
  }

  filter(candidates: readonly RouteCandidate[]): readonly RouteCandidate[] {
    return candidates
      .map((c) => this.evaluate(c))
      .filter((d) => d.eligible)
      .map((d) => d.candidate);
  }
}

/**
 * In-memory reservation lease store with lazy TTL cleanup. The bounded sweep
 * runs before acquisition so abandoned local metadata cannot grow forever.
 */
export class ReservationManager {
  private leases = new Map<string, Reservation>();
  private lastSweepAt = 0;
  private static readonly SWEEP_INTERVAL_MS = 30_000;

  private sweepExpired(now: number): void {
    if (now - this.lastSweepAt < ReservationManager.SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const [leaseId, reservation] of this.leases) {
      if (reservation.expires_at < now) this.leases.delete(leaseId);
    }
  }

  acquire(candidate: RouteCandidate, _revision: RoutingRevision, ttlMs = 30_000): Reservation {
    const now = Date.now();
    this.sweepExpired(now);
    const lease_id = `${candidate.provider_id}:${candidate.model_id}:${now}:${Math.random().toString(16).slice(2)}`;
    const r: Reservation = {
      candidate,
      lease_id,
      acquired_at: now,
      expires_at: now + ttlMs,
    };
    this.leases.set(lease_id, r);
    return r;
  }

  release(lease_id: string): void {
    this.leases.delete(lease_id);
  }

  get(lease_id: string): Reservation | undefined {
    const r = this.leases.get(lease_id);
    if (!r) return undefined;
    if (r.expires_at < Date.now()) {
      this.leases.delete(lease_id);
      return undefined;
    }
    return r;
  }

  /** Test/diagnostic seam: current lease count without triggering a sweep. */
  size(): number {
    return this.leases.size;
  }
}

export class RoundRobinState {
  private idx = 0;
  private servedByCurrent = 0;
  next(candidates: readonly RouteCandidate[], rotateCount: number): RouteCandidate | undefined {
    if (candidates.length === 0) return undefined;
    const safeCount = Math.max(1, Math.min(1000, Math.trunc(rotateCount)));
    const c = candidates[this.idx % candidates.length];
    this.servedByCurrent += 1;
    if (this.servedByCurrent >= safeCount) {
      this.idx = (this.idx + 1) % 1000000;
      this.servedByCurrent = 0;
    }
    return c;
  }
}
/**
 * Upper bound on per-key round-robin state. Keys are tenant/provider/model
 * combinations; without a cap, a deployment serving a long tail of unique
 * combinations would retain one entry forever. 1000 is far above the working
 * set of any real catalog, so eviction only ever targets genuinely cold keys.
 */
const MAX_ROUND_ROBIN_ENTRIES = 1000;

/**
 * Bounded LRU accessor for round-robin state: an existing key is refreshed to
 * the tail (most-recently-used), and inserting past the cap evicts the head
 * (least-recently-used). Keeps the hot routing working set while guaranteeing
 * the map cannot grow without bound.
 */
function getOrCreateRoundRobin(
  map: Map<string, RoundRobinState>,
  key: string,
): RoundRobinState {
  const existing = map.get(key);
  if (existing) {
    map.delete(key);
    map.set(key, existing);
    return existing;
  }
  if (map.size >= MAX_ROUND_ROBIN_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  const created = new RoundRobinState();
  map.set(key, created);
  return created;
}

export class RoutingEngine {
  private readonly _roundRobinByCombo = new Map<string, RoundRobinState>();
  private readonly _roundRobinByProvider = new Map<string, RoundRobinState>();
  private readonly eligibility = new EligibilityEvaluator();
  private readonly reservations = new ReservationManager();

  constructor(
    private readonly admission: AdmissionController = new InMemoryAdmissionController(),
  ) {}

  private getRoundRobin(key: string): RoundRobinState {
    return getOrCreateRoundRobin(this._roundRobinByCombo, key);
  }

  private getProviderRoundRobin(key: string): RoundRobinState {
    return getOrCreateRoundRobin(this._roundRobinByProvider, key);
  }

  /** Observable bounded-collection sizes for the runtime metrics sampler. */
  roundRobinEntries(): { readonly combo: number; readonly provider: number } {
    return { combo: this._roundRobinByCombo.size, provider: this._roundRobinByProvider.size };
  }

  private resolveProviderRouting(
    snapshot: RouteSnapshot,
    providerId: string,
    tenantId: string | null,
  ): ProviderRoutingSetting | undefined {
    const routing = snapshot.providerRouting;
    if (!routing) return undefined;
    const tenantKey = tenantId ?? "__global__";
    const tenantBucket = (routing as Record<string, Record<string, ProviderRoutingSetting>>)[
      tenantKey
    ];
    if (tenantBucket?.[providerId]) return tenantBucket[providerId];
    const globalBucket = (routing as Record<string, Record<string, ProviderRoutingSetting>>)[
      "__global__"
    ];
    if (globalBucket?.[providerId]) return globalBucket[providerId];
    return undefined;
  }

  private reorderRun(
    run: RouteCandidate[],
    settings: ProviderRoutingSetting | undefined,
    tid: string | null,
  ): RouteCandidate[] {
    if (!settings || !settings.enabled || settings.strategy === "fallback") {
      return [...run];
    }
    const rrKey = `${tid ?? "__global__"}::${run[0]!.provider_id}`;
    const rr = this.getProviderRoundRobin(rrKey);
    const chosen = rr.next(run, settings.rotateCount);
    if (!chosen) return [...run];
    const idx = run.indexOf(chosen);
    if (idx <= 0) return [...run];
    return [...run.slice(idx), ...run.slice(0, idx)];
  }

  private applyProviderRouting(
    eligible: readonly RouteCandidate[],
    snapshot: RouteSnapshot,
    tid: string | null,
  ): RouteCandidate[] {
    if (eligible.length <= 1) return [...eligible];
    if (!snapshot.providerRouting) return [...eligible];
    const result: RouteCandidate[] = [];
    let i = 0;
    while (i < eligible.length) {
      const cur = eligible[i]!;
      const runKey = `${cur.provider_id}::${cur.model_id}`;
      let j = i + 1;
      while (
        j < eligible.length &&
        `${eligible[j]!.provider_id}::${eligible[j]!.model_id}` === runKey
      )
        j++;
      const run = eligible.slice(i, j);
      if (run.length > 1) {
        const settings = this.resolveProviderRouting(snapshot, cur.provider_id, tid);
        const reordered = this.reorderRun([...run], settings, tid);
        result.push(...reordered);
      } else {
        result.push(...run);
      }
      i = j;
    }
    return result;
  }

  async plan(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tenantId?: string | null,
    requiredCapabilities?: readonly RequiredCapability[],
    allowCliMappings = false,
  ): Promise<RoutePlan> {
    const tid = tenantId ?? null;
    const { resolved, matching } = this.resolveMatchingCandidates(
      requestedModel,
      snapshot,
      tid,
      allowCliMappings,
    );
    // `matching` non-empty but nothing eligible means every account serving
    // this model is currently unusable — NOT a missing model. Distinct from
    // the `matching.length === 0` throw in the resolver, which is a genuine 404.
    const decisions = matching.map((candidate) => this.eligibility.evaluate(candidate));
    let eligible = decisions.filter((d) => d.eligible).map((d) => d.candidate);
    if (eligible.length === 0) {
      throw accountsUnavailableError(
        requestedModel,
        decisions.map((d) => d.reason),
        resolved.model,
      );
    }
    // Capability-aware routing: filter against snapshot capability profiles
    // (shared predicate with the planner). Empty here means no candidate
    // supports the variant — the planner catches this code and re-plans a
    // degraded variant; model/tenant/ambiguity errors above still throw.
    if (requiredCapabilities !== undefined && requiredCapabilities.length > 0) {
      eligible = eligible.filter((candidate) =>
        candidateSupportsRequest(candidate, requiredCapabilities),
      );
      // No fusion and no silent model switch. The requested model cannot serve
      // this requirement set, so the planner degrades it in place (media becomes
      // a placeholder, controls are dropped) and re-plans. When nothing
      // degradable remains, the request fails as `capability_unsupported`
      // rather than being served by a different model the caller never asked for.
      if (eligible.length === 0)
        throw capabilityUnsupportedError(requiredCapabilities.join(", "));
    }
    eligible = this.applyProviderRouting(eligible, snapshot, tid);
    const chosen = eligible[0]!;
    return {
      revision: snapshot.revision,
      candidates: eligible,
      requested_model: requestedModel,
      resolved_model: resolved.model,
      provider_id: chosen.provider_id,
    };
  }

  /**
   * Resolves the requested name to a bare target, expands a combo into its
   * member models, and returns the candidates serving them in plan order.
   *
   * Both alias resolution and the ambiguity check judge the *resolved* bare
   * target, never the originally requested name: an alias resolving to a bare
   * model that multiple providers serve must be rejected exactly like
   * requesting that bare model directly, so resolving through an alias is
   * never a silent way to bypass ambiguity protection.
   */
  private resolveMatchingCandidates(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tid: string | null,
    allowCliMappings: boolean,
  ): {
    resolved: ReturnType<typeof resolveAlias>;
    combo: ComboDefinition | undefined;
    matching: RouteCandidate[];
  } {
    const safeResolve = (name: string) => {
      try {
        return resolveAlias(name, snapshot, tid, allowCliMappings);
      } catch {
        throw modelNotFoundError(requestedModel);
      }
    };
    const resolved = safeResolve(requestedModel);
    const comboMap = tid ? snapshot.combos[tid] : undefined;
    const combo = comboMap?.[resolved.model];
    const rawModelIds = combo
      ? combo.members.flatMap((name) => {
          const alias = safeResolve(name);
          const nested = comboMap?.[alias.model];
          return nested ? nested.members : [alias.model];
        })
      : [resolved.model];
    const modelIds = [...new Set(rawModelIds)];
    let matching = snapshot.candidates.filter(
      (candidate) =>
        modelIds.some((id) => candidateMatches(candidate, id)) &&
        (candidate.tenant_id == null || candidate.tenant_id === tid),
    );
    if (combo) {
      const groups = modelIds
        .map((id) => matching.filter((c) => candidateMatches(c, id)))
        .filter((g) => g.length > 0);
      if (combo.strategy === "round_robin" && groups.length > 1) {
        const heads = groups.map((g) => g[0] as RouteCandidate);
        const rr = this.getRoundRobin(`${tid}::${resolved.model}`);
        const chosen = rr.next(heads, 1);
        const startIndex = chosen ? heads.indexOf(chosen) : 0;
        matching = [...groups.slice(startIndex), ...groups.slice(0, startIndex)].flat();
      } else {
        matching = groups.flat();
      }
    }
    if (matching.length === 0) throw modelNotFoundError(requestedModel, modelIds);
    const owners = [...new Set(matching.map((candidate) => candidate.provider_id))];
    if (owners.length > 1 && !resolved.model.includes("/") && !combo)
      throw ambiguousModelError(requestedModel, owners);
    return { resolved, combo, matching };
  }

  async reserve(plan: RoutePlan): Promise<Reservation> {
    for (const candidate of plan.candidates) {
      const admitted = await this.admission.admit(candidate);
      if (admitted.admitted) return this.reservations.acquire(candidate, plan.revision);
    }
    throw capacityExhaustedError();
  }
  async release(reservation: Reservation): Promise<void> {
    await this.admission.release(reservation);
    this.reservations.release(reservation.lease_id);
  }
}

