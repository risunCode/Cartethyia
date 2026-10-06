// Routing model resolution and route planning.
import { log } from "../../observability/logger";
import {
  accountsRateLimitedError,
  accountsUnavailableError,
  ambiguousModelError,
  capacityExhaustedError,
  capabilityUnsupportedError,
  modelNotFoundError,
  type AdmissionController,
  type ComboDefinition,
  type ProviderRoutingSetting,
  type Reservation,
  type RouteCandidate,
  type RoutePlan,
  type EligibilityDecision,
  type RouteSnapshot,
} from "./route-model";
import {
  candidateSupportsRequest,
  type RequiredCapability,
} from "../translation/capabilities";
import { InMemoryAdmissionController } from "./admission";
import { ReservationManager } from "./reservations";
import { getOrCreateRoundRobin, RoundRobinState } from "./round-robin";
import { SEARCH_PROVIDER_ORDER } from "../dispatch/websearch";

const SEARCH_PROVIDER_RANK = new Map<string, number>(
  SEARCH_PROVIDER_ORDER.map((provider, index) => [provider, index]),
);


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
 * remain available. `keyId` is required to read the key's own CLI routes —
 * without it CLI mappings are silently skipped even when `allowCliMappings`
 * is true.
 */
export function resolveAliasTarget(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  requested: string,
  allowCliMappings = false,
  keyId?: string,
): string {
  try {
    return resolveAlias(requested, snapshot, tenantId, allowCliMappings, keyId).model;
  } catch {
    return requested;
  }
}

function aliasMapFor(
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings: boolean,
  keyId?: string,
): Record<string, string> | undefined {
  if (!tenantId) return undefined;
  const aliases = snapshot.aliases?.[tenantId];
  const cliAliases = allowCliMappings
    ? keyId
      ? snapshot.cli_aliases?.[`${tenantId}:${keyId}`] ?? snapshot.cli_aliases?.[tenantId]
      : snapshot.cli_aliases?.[tenantId]
    : undefined;
  if (!aliases && !cliAliases) return undefined;
  return { ...(aliases ?? {}), ...(cliAliases ?? {}) };
}

function resolveAlias(
  requested: string,
  snapshot: RouteSnapshot,
  tenantId: string | null,
  allowCliMappings = false,
  keyId?: string,
): { model: string; chain: readonly string[] } {
  const aliasMap = aliasMapFor(snapshot, tenantId, allowCliMappings, keyId);
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
 *
 * A cooling account is *deprioritized*, not excluded. Cooling means "recently
 * failed, try something else first", not "cannot serve this request": a quota
 * cooldown is usually scoped to one model or one provider, the deadline can be
 * the classifier's own fallback rather than the provider's statement, and a
 * per-request refusal (a bid the upstream declined) can park an otherwise
 * healthy account for an hour. Excluding it made the gateway answer
 * `accounts_unavailable` while a usable credential sat idle — reported as
 * "cooldown blocks the account completely". Ordering is what carries the
 * intent instead: `plan()` sorts cooling candidates after every healthy one,
 * so they are reached only when nothing better is left.
 *
 * That ordering only helps while a healthy sibling exists. Once *every* eligible
 * candidate is cooling there is nothing to fail over to, and dialing a cooling
 * account can only reproduce the refusal that cooled it — the operator's "still
 * hit a cooled-down account, never failed over" report. `plan()` therefore
 * answers `accountsRateLimitedError` (429) in that end state instead of
 * planning a cooling account; the evaluator itself still returns `cooldown`
 * candidates eligible, because the ordering above is what the plan needs to
 * build the healthy-first list.
 *
 * `model_cooldown` reaches that same 429 by a different route: the evaluator
 * excludes it outright, so when it is the only reason nothing is eligible
 * `plan()` reports it as a time-bounded refusal rather than 503
 * `accounts_unavailable`. See the branch in `plan()`.
 *
 * `model_cooldown` is the exception, and a hard exclusion. It is the snapshot's
 * marker for an *unexpired per-model* entry on the candidate whose model is
 * being planned — the upstream stated this exact (account, model) pair is
 * exhausted until a named reset. That is a verdict about this request, not a
 * general "try later": the deadline is the provider's own statement, retrying
 * inside it can only reproduce the refusal, and the account keeps serving every
 * other model it holds. Deprioritizing it instead made failover burn a full
 * round trip on a known-refused account after every healthy sibling failed, and
 * logged a fresh `active → cooldown` row on each attempt.
 *
 * `disabled` stays a hard exclusion: it is an operator decision, and only an
 * operator restores it.
 */
export class EligibilityEvaluator {
  evaluate(candidate: RouteCandidate): EligibilityDecision {
    const state = candidate as RouteCandidate & {
      readonly health_status?: string;
      readonly cooldown_kind?: "hard" | "soft";
      readonly account_locked?: boolean;
      readonly locked?: boolean;
    };
    if (state.account_locked || state.locked)
      return { eligible: false, reason: "locked", candidate };
    if (state.health_status === "disabled")
      return { eligible: false, reason: "disabled", candidate };
    if (state.health_status === "model_cooldown")
      return { eligible: false, reason: "model_cooldown", candidate };
    if (state.health_status === "cooldown" && state.cooldown_kind === "hard")
      return { eligible: false, reason: "cooldown_hard", candidate };
    if (state.health_status === "cooldown")
      return { eligible: true, reason: "cooldown", candidate };
    return { eligible: true, reason: "healthy", candidate };
  }

  filter(candidates: readonly RouteCandidate[]): readonly RouteCandidate[] {
    return candidates
      .map((c) => this.evaluate(c))
      .filter((d) => d.eligible)
      .map((d) => d.candidate);
  }
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

  /** Live admission counters by `provider:model[:account]` bucket. */
  async accountInflightSnapshot(): Promise<ReadonlyMap<string, number>> {
    // Both controllers hand back a fresh map, so no defensive copy here —
    // this feeds an admin read, not a mutation site.
    return (await this.admission.snapshotAccountInflight?.()) ?? new Map();
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
  private searchFallbackCandidates(
    snapshot: RouteSnapshot,
    tenantId: string | null,
  ): RouteCandidate[] {
    const ranked = snapshot.candidates
      .filter(
        (candidate) =>
          candidate.service_kind === "websearch" &&
          (candidate.tenant_id == null || candidate.tenant_id === tenantId),
      )
      .sort((left, right) => {
        const leftRank =
          SEARCH_PROVIDER_RANK.get(left.provider_id.toLowerCase()) ?? SEARCH_PROVIDER_ORDER.length;
        const rightRank =
          SEARCH_PROVIDER_RANK.get(right.provider_id.toLowerCase()) ?? SEARCH_PROVIDER_ORDER.length;
        return leftRank - rightRank;
      });
    const decisions = ranked
      .map((candidate) => this.eligibility.evaluate(candidate))
      .filter((decision) => decision.eligible);
    const ordered = this.applyProviderRouting(
      [
        ...decisions.filter((decision) => decision.reason !== "cooldown").map((decision) => decision.candidate),
        ...decisions.filter((decision) => decision.reason === "cooldown").map((decision) => decision.candidate),
      ],
      snapshot,
      tenantId,
    );
    return ordered.map((candidate) => ({ ...candidate, search_route: "fallback" as const }));
  }


  async plan(
    requestedModel: string,
    snapshot: RouteSnapshot,
    tenantId?: string | null,
    requiredCapabilities?: readonly RequiredCapability[],
    allowCliMappings = false,
    keyId?: string,
    webSearch = false,
  ): Promise<RoutePlan> {
    const tid = tenantId ?? null;
    const { resolved, matching, unmatchedMembers } = this.resolveMatchingCandidates(
      requestedModel,
      snapshot,
      tid,
      allowCliMappings,
      keyId,
    );
    // `matching` non-empty but nothing eligible means every account serving
    // this model is currently unusable — NOT a missing model. Distinct from
    // the `matching.length === 0` throw in the resolver, which is a genuine 404.
    const decisions = matching.map((candidate) => this.eligibility.evaluate(candidate));
    let eligible = decisions.filter((d) => d.eligible).map((d) => d.candidate);
    if (eligible.length === 0) {
      // A time-bounded exclusion answers 429, not 503. Both reasons here carry
      // a deadline the upstream itself stated, so the request is not
      // "unavailable" — it is "not until the reset", and the client is owed an
      // answer it can retry against. `model_cooldown` belongs in the same
      // bucket as `cooldown_hard` for exactly the reason the evaluator's own
      // comment gives: the upstream said this (account, model) pair is
      // exhausted until a named reset, so dialing it can only reproduce the
      // refusal. Answering 503 there told the client the model was down when
      // every account serving it was merely resting, which is the "503 DOWN
      // while the model is allowed" report — and 503 invites a client to give
      // up or fail a health check, where 429 says retry later.
      const rateLimited = decisions.some(
        (d) => d.reason === "cooldown_hard" || d.reason === "model_cooldown",
      );
      if (rateLimited) {
        throw accountsRateLimitedError(requestedModel, resolved.model);
      }
      // Combo members without any routable candidate never reach the client
      // envelope — but the operator needs them to fix the combo, so they go
      // to the server logs with the full resolution picture.
      if (unmatchedMembers.length > 0) {
        log.warn("[routing] combo members without routable candidates", {
          requested: requestedModel,
          routed: resolved.model,
          unmatched: [...new Set(unmatchedMembers)].sort(),
        });
      }
      throw accountsUnavailableError(
        requestedModel,
        decisions.map((d) => d.reason),
      );
    }
    // Every eligible candidate is account-wide cooling: no healthy account is
    // left to serve this request. Cooling accounts stay eligible so the ORDER
    // below can deprioritize them behind healthy siblings, but once nothing but
    // cooling remains there is no sibling to fail over to — dialing a cooling
    // account can only reproduce the refusal that cooled it, and doing so made
    // the gateway "still hit a cooled-down account" instead of answering the
    // client honestly. Answer 429 (rate limited) so the client retries after
    // the reset rather than 503 capacity that is merely resting.
    const healthyCount = decisions.filter(
      (d) => d.eligible && d.reason !== "cooldown",
    ).length;
    if (healthyCount === 0) {
      throw accountsRateLimitedError(requestedModel, resolved.model);
    }
    // Cooling accounts are eligible but tried last: a healthy candidate that
    // can serve the request must win, while a deployment whose only account is
    // cooling still routes instead of failing. Sorted on the evaluator's reason
    // so the ordering and the eligibility rule cannot disagree about which
    // candidates are cooling.
    const cooling = new Set(
      decisions
        .filter((decision) => decision.eligible && decision.reason === "cooldown")
        .map((decision) => decision.candidate),
    );
    if (cooling.size > 0 && cooling.size < eligible.length) {
      eligible = [
        ...eligible.filter((candidate) => !cooling.has(candidate)),
        ...eligible.filter((candidate) => cooling.has(candidate)),
      ];
    }
    // Capability-aware routing: filter against snapshot capability profiles
    // (shared predicate with the planner). Empty here means no candidate
    // supports the variant — the planner catches this code and re-plans a
    // degraded variant; model/tenant/ambiguity errors above still throw.
    if (requiredCapabilities !== undefined && requiredCapabilities.length > 0) {
      eligible = eligible.filter((candidate) =>
        candidateSupportsRequest(candidate, requiredCapabilities),
      );
      // No silent model switch. The requested model cannot serve
      // this requirement set, so the planner degrades it in place (media becomes
      // a placeholder, controls are dropped) and re-plans. When nothing
      // degradable remains, the request fails as `capability_unsupported`
      // rather than being served by a different model the caller never asked for.
      if (eligible.length === 0)
        throw capabilityUnsupportedError(requiredCapabilities.join(", "));
    }
    eligible = this.applyProviderRouting(eligible, snapshot, tid);
    // Re-assert the cooling order: `applyProviderRouting` rotates accounts
    // within one `provider::model` run, and that rotation is by design blind to
    // health — so it can float a cooling account back to the front and undo the
    // deprioritization above. Sorting again here is what makes the cooling rule
    // hold regardless of the operator's rotation strategy. A stable partition
    // keeps the rotation's own ordering inside each group.
    if (cooling.size > 0 && cooling.size < eligible.length) {
      eligible = [
        ...eligible.filter((candidate) => !cooling.has(candidate)),
        ...eligible.filter((candidate) => cooling.has(candidate)),
      ];
    }
    if (webSearch) {
      const searchCandidates = eligible.map((candidate) =>
        (candidate.service_kind ?? "llm") === "llm" &&
        candidate.capability_profile.webSearch === true
          ? { ...candidate, search_route: "native" as const }
          : candidate,
      );
      eligible = [
        ...searchCandidates,
        ...this.searchFallbackCandidates(snapshot, tid),
      ];
    }
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
    keyId?: string,
  ): {
    resolved: ReturnType<typeof resolveAlias>;
    combo: ComboDefinition | undefined;
    matching: RouteCandidate[];
    /** Combo members that matched zero candidates — misconfigured or
     * connection-less members the operator should fix, surfaced on errors
     * instead of failing opaquely on whichever member happened to route. */
    unmatchedMembers: readonly string[];
  } {
    const safeResolve = (name: string) => {
      try {
        return resolveAlias(name, snapshot, tid, allowCliMappings, keyId);
      } catch {
        throw modelNotFoundError(requestedModel);
      }
    };
    const resolved = safeResolve(requestedModel);
    const comboMap = tid ? snapshot.combos[tid] : undefined;
    const combo = comboMap?.[resolved.model];
    // Combo members may themselves be aliases or combos (an alias may target
    // a combo, and a combo may nest another combo). Resolve recursively with
    // the same depth bound as the alias walk so a member that names a combo
    // expands to its models instead of matching no candidate and reading as
    // "model not found" for a route the operator actually defined.
    const expandMember = (name: string, seen: ReadonlySet<string>): readonly string[] => {
      if (seen.has(name) || seen.size >= 16) return [];
      const next = new Set(seen).add(name);
      const alias = safeResolve(name);
      const nested = comboMap?.[alias.model];
      if (!nested) return [alias.model];
      return nested.members.flatMap((member) => expandMember(member, next));
    };
    const rawModelIds = combo
      ? combo.members.flatMap((name) => expandMember(name, new Set([resolved.model])))
      : [resolved.model];
    const modelIds = [...new Set(rawModelIds)];
    let matching = snapshot.candidates.filter(
      (candidate) =>
        modelIds.some((id) => candidateMatches(candidate, id)) &&
        (candidate.tenant_id == null || candidate.tenant_id === tid),
    );
    let unmatchedMembers: readonly string[] = [];
    if (combo) {
      const perId = modelIds.map((id) => ({
        id,
        group: matching.filter((c) => candidateMatches(c, id)),
      }));
      unmatchedMembers = perId.filter((entry) => entry.group.length === 0).map((entry) => entry.id);
      const groups = perId.map((entry) => entry.group).filter((g) => g.length > 0);
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
    return { resolved, combo, matching, unmatchedMembers };
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
