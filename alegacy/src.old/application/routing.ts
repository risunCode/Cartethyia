/**
 * Deterministic rendezvous affinity.
 *
 * Stateless replacement for the legacy in-memory rotation cursors: the same
 * affinity key always yields the same ordering, across processes and across
 * restarts, so repeated requests from one client stay on the same route
 * without any shared mutable state.
 */

import type { AffinityKey } from "./contracts";

/** Compact, unambiguous string form of an application affinity key (namespace + value). */
export function affinityKeyString(key: AffinityKey): string {
  return `${key.namespace}:${key.value}`;
}
/** Selection reasons shared by route, credential, and network observability. */
export type SelectionReason = "preferred" | "sticky" | "round_robin" | "least_loaded" | "usage_headroom" | "fallback";

/** Bounded metadata describing one already-selected route candidate. */
export interface SelectionDecision {
  readonly candidateId: string;
  readonly reason: SelectionReason;
  readonly affinityKey?: string;
  readonly excludedCandidateIds: readonly string[];
}

/** Input for creating a selection decision without changing selector behavior. */
export interface SelectionDecisionInput {
  readonly candidateId: string;
  readonly reason: SelectionReason;
  readonly affinityKey?: AffinityKey | string | null;
  readonly excludedCandidateIds?: readonly string[];
}

/**
 * Records selection metadata around an existing selector result.
 *
 * This helper deliberately does not rank or filter candidates: the credential,
 * network, and route selectors remain the owners of selection policy.
 */
export function createSelectionDecision(input: SelectionDecisionInput): SelectionDecision {
  let affinity: string | undefined;
  if (typeof input.affinityKey === "string") {
    affinity = input.affinityKey;
  } else if (input.affinityKey !== null && input.affinityKey !== undefined) {
    affinity = affinityKeyString(input.affinityKey);
  }
  const excluded = [...new Set(input.excludedCandidateIds ?? [])].filter((candidateId) => candidateId !== input.candidateId);
  return {
    candidateId: input.candidateId,
    reason: input.reason,
    ...(affinity === undefined ? {} : { affinityKey: affinity }),
    excludedCandidateIds: excluded,
  };
}


/**
 * FNV-1a 32-bit over `key \0 candidateId` — pure integer arithmetic, stable
 * on every platform. Higher score wins rendezvous ordering.
 */
export function rendezvousScore(key: string, candidateId: string): number {
  let hash = 0x811c9dc5;
  const input = `${key}\u0000${candidateId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Orders `items` by rendezvous score for `key` (descending), breaking ties
 * by id ascending so the result is fully deterministic regardless of the
 * input order.
 */
export function orderByRendezvous<T>(
  key: string,
  items: readonly T[],
  idOf: (item: T) => string,
): readonly T[] {
  return [...items].sort((left, right) => {
    const leftScore = rendezvousScore(key, idOf(left));
    const rightScore = rendezvousScore(key, idOf(right));
    if (leftScore !== rightScore) return rightScore - leftScore;
    const leftId = idOf(left);
    const rightId = idOf(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

/**
 * Model reference resolution: provider-qualified parsing, alias resolution,
 * and combo expansion chained into a single deterministic resolution.
 *
 * All lookups (prefixes, aliases, combos) are injected as plain maps so the
 * module stays pure — callers build the maps from their own configuration
 * or repositories.
 */


/** A fully qualified model target: provider + model id. */
export interface ResolvedModel {
  readonly providerId: string;
  readonly modelId: string;
}

export type ComboStrategy = "fallback" | "round-robin";

/** A named combo: ordered member models plus rotation semantics. */
export interface ComboDefinition {
  readonly id: string;
  readonly models: readonly string[];
  readonly strategy: ComboStrategy;
  /**
   * 0 = no affinity stickiness (global deterministic order);
   * > 0 = per-affinity-key deterministic order.
   */
  readonly stickyLimit: number;
}

/** Injected lookup tables for model reference resolution. */
export interface ModelReferenceConfig {
  /** Alias prefix → provider id, e.g. "opencode" → "opencodeft". */
  readonly prefixes: ReadonlyMap<string, string>;
  /** Model name alias → target model name (may itself be qualified or a combo name). */
  readonly aliases: ReadonlyMap<string, string>;
  /** Named combos. */
  readonly combos: ReadonlyMap<string, ComboDefinition>;
}

export type ModelReferenceParseResult =
  | { readonly kind: "qualified"; readonly providerId: string; readonly modelId: string }
  | { readonly kind: "unqualified" }
  | { readonly kind: "invalid"; readonly reason: string };

export type ModelResolutionDiagnosticCode = "cycle" | "max_depth" | "empty_combo" | "unresolved_member" | "unknown_reference";

/** Secret-free explanation for an unresolved model reference or combo member. */
export interface ModelResolutionDiagnostic {
  readonly code: ModelResolutionDiagnosticCode;
  readonly path: readonly string[];
  readonly comboId?: string;
  readonly member?: string;
}

export type ChainResult =
  | { readonly kind: "qualified"; readonly model: ResolvedModel }
  | { readonly kind: "combo"; readonly candidates: readonly ResolvedModel[]; readonly diagnostics?: readonly ModelResolutionDiagnostic[] }
  | { readonly kind: "unresolved" };

/** Detailed result that keeps unresolved combo diagnostics without changing the legacy result kind. */
export interface ModelChainResolution {
  readonly result: ChainResult;
  readonly diagnostics: readonly ModelResolutionDiagnostic[];
}

/** Recursion cap for alias→alias and alias→combo chains (loops terminate). */
export const MAX_MODEL_CHAIN_DEPTH = 8;

const MAX_MODEL_DIAGNOSTICS = 32;

/**
 * Parses a provider-qualified model name (`prefix/modelId`).
 *
 * Splits at the **first** `/` — the first segment is the provider prefix,
 * everything after it is the model ID (preserving internal slashes for
 * multi-segment IDs like `openai/gpt-5.4`). Prefixes are always single
 * segment (provider IDs or custom-provider slugs), so a single split is
 * correct and a longest-prefix loop would be dead machinery.
 *
 * Unknown prefixes are reported as invalid so the caller can fall through to
 * alias/combo resolution instead of rejecting outright.
 */
export function parseModelReference(
  model: string,
  prefixes: ReadonlyMap<string, string>,
): ModelReferenceParseResult {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) return { kind: "unqualified" };

  const prefix = model.slice(0, slashIndex);
  const modelId = model.slice(slashIndex + 1);
  if (!prefix || !modelId) {
    return {
      kind: "invalid",
      reason: "Provider-qualified model names must include both a provider prefix and a model ID.",
    };
  }

  const providerId = prefixes.get(prefix);
  if (providerId !== undefined) {
    return { kind: "qualified", providerId, modelId };
  }

  return {
    kind: "invalid",
    reason: `Unknown provider prefix "${prefix}".`,
  };
}

/** Looks up a model name alias; returns null when the name is not aliased. */
export function resolveAlias(name: string, aliases: ReadonlyMap<string, string>): string | null {
  return aliases.get(name) ?? null;
}

/**
 * Expands a combo into ordered qualified candidates and records members that
 * could not be resolved. Duplicate targets are dropped (first occurrence
 * wins); strategy and rendezvous ordering remain unchanged.
 */
export function expandComboWithDiagnostics(
  combo: ComboDefinition,
  resolveMember: (modelName: string) => ChainResult | ModelChainResolution,
  affinityKey: AffinityKey | null,
): { readonly candidates: readonly ResolvedModel[]; readonly diagnostics: readonly ModelResolutionDiagnostic[] } {
  const members: ResolvedModel[] = [];
  const diagnostics: ModelResolutionDiagnostic[] = [];
  for (const member of combo.models) {
    const resolved = resolveMember(member);
    const result = "result" in resolved ? resolved.result : resolved;
    const memberDiagnostics = "result" in resolved ? resolved.diagnostics : result.kind === "combo" ? result.diagnostics ?? [] : [];
    if (result.kind === "qualified") {
      members.push(result.model);
    } else if (result.kind === "combo") {
      members.push(...result.candidates);
      diagnostics.push(...memberDiagnostics);
    } else {
      diagnostics.push(...memberDiagnostics);
      if (memberDiagnostics.length === 0) {
        diagnostics.push({ code: "unresolved_member", comboId: combo.id, member, path: [member] });
      }
    }
  }

  const seen = new Set<string>();
  const unique = members.filter((model) => {
    const key = `${model.providerId}/${model.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ordered =
    combo.strategy === "fallback"
      ? unique
      : orderByRendezvous(
          combo.stickyLimit > 0 && affinityKey !== null ? affinityKeyString(affinityKey) : `combo:${combo.id}`,
          unique,
          (model) => `${model.providerId}/${model.modelId}`,
        );
  return { candidates: ordered, diagnostics: deduplicateDiagnostics(diagnostics) };
}

/**
 * Backward-compatible candidate-only combo expansion.
 *
 * Callers that need to observe unresolved members should use
 * {@link expandComboWithDiagnostics}; valid member ordering is identical.
 */
export function expandCombo(
  combo: ComboDefinition,
  resolveMember: (modelName: string) => ChainResult,
  affinityKey: AffinityKey | null,
): readonly ResolvedModel[] {
  return expandComboWithDiagnostics(combo, resolveMember, affinityKey).candidates;
}

function deduplicateDiagnostics(diagnostics: readonly ModelResolutionDiagnostic[]): readonly ModelResolutionDiagnostic[] {
  const seen = new Set<string>();
  const deduplicated: ModelResolutionDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.comboId ?? "",
      diagnostic.member ?? "",
      diagnostic.path.join("\u0000"),
    ].join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(diagnostic);
    if (deduplicated.length >= MAX_MODEL_DIAGNOSTICS) break;
  }
  return deduplicated;
}

/**
 * Resolves a model reference while retaining bounded, secret-free diagnostics
 * for cycles, empty combos, and unresolved nested members.
 */
export function resolveModelChainWithDiagnostics(
  rawModel: string,
  config: ModelReferenceConfig,
  affinityKey: AffinityKey | null = null,
): ModelChainResolution {
  type InternalResult =
    | { readonly kind: "qualified"; readonly model: ResolvedModel; readonly diagnostics: readonly ModelResolutionDiagnostic[] }
    | { readonly kind: "combo"; readonly candidates: readonly ResolvedModel[]; readonly diagnostics: readonly ModelResolutionDiagnostic[] }
    | { readonly kind: "unresolved"; readonly diagnostics: readonly ModelResolutionDiagnostic[] };

  const resolveInner = (name: string, depth: number, path: readonly string[]): InternalResult => {
    if (depth > MAX_MODEL_CHAIN_DEPTH) {
      return { kind: "unresolved", diagnostics: [{ code: "max_depth", path: [...path, name] }] };
    }

    const parsed = parseModelReference(name, config.prefixes);
    if (parsed.kind === "qualified") {
      return {
        kind: "qualified",
        model: { providerId: parsed.providerId, modelId: parsed.modelId },
        diagnostics: [],
      };
    }
    if (path.includes(name)) {
      return { kind: "unresolved", diagnostics: [{ code: "cycle", path: [...path, name] }] };
    }

    const aliasTarget = resolveAlias(name, config.aliases);
    if (aliasTarget !== null) {
      const resolved = resolveInner(aliasTarget, depth + 1, [...path, name]);
      if (resolved.kind !== "unresolved") return resolved;
    }

    const combo = config.combos.get(name);
    if (combo === undefined) {
      return { kind: "unresolved", diagnostics: [{ code: "unknown_reference", path: [...path, name] }] };
    }
    if (depth >= MAX_MODEL_CHAIN_DEPTH - 1) {
      return { kind: "unresolved", diagnostics: [{ code: "max_depth", comboId: combo.id, path: [...path, name] }] };
    }

    const members: ResolvedModel[] = [];
    const diagnostics: ModelResolutionDiagnostic[] = [];
    const comboPath = [...path, name];
    for (const member of combo.models) {
      const resolved = resolveInner(member, depth + 1, comboPath);
      if (resolved.kind === "qualified") {
        members.push(resolved.model);
      } else if (resolved.kind === "combo") {
        members.push(...resolved.candidates);
        diagnostics.push(...resolved.diagnostics);
      } else {
        diagnostics.push(...resolved.diagnostics);
        if (resolved.diagnostics.length === 0) {
          diagnostics.push({ code: "unresolved_member", comboId: combo.id, member, path: [...comboPath, member] });
        }
      }
    }

    const seen = new Set<string>();
    const unique = members.filter((model) => {
      const key = `${model.providerId}/${model.modelId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const ordered =
      combo.strategy === "fallback"
        ? unique
        : orderByRendezvous(
            combo.stickyLimit > 0 && affinityKey !== null ? affinityKeyString(affinityKey) : `combo:${combo.id}`,
            unique,
            (model) => `${model.providerId}/${model.modelId}`,
          );
    const deduplicated = deduplicateDiagnostics(diagnostics);
    if (ordered.length === 0) {
      return {
        kind: "unresolved",
        diagnostics: deduplicateDiagnostics([
          ...deduplicated,
          { code: "empty_combo", comboId: combo.id, path: comboPath },
        ]),
      };
    }
    return { kind: "combo", candidates: ordered, diagnostics: deduplicated };
  };

  const internal = resolveInner(rawModel, 0, []);
  let result: ChainResult;
  if (internal.kind === "qualified") {
    result = { kind: "qualified", model: internal.model };
  } else if (internal.kind === "combo") {
    if (internal.diagnostics.length === 0) {
      result = { kind: "combo", candidates: internal.candidates };
    } else {
      result = { kind: "combo", candidates: internal.candidates, diagnostics: internal.diagnostics };
    }
  } else {
    result = { kind: "unresolved" };
  }
  return { result, diagnostics: internal.diagnostics };
}

/** Resolves a model reference while preserving the legacy ChainResult shape. */
export function resolveModelChain(
  rawModel: string,
  config: ModelReferenceConfig,
  affinityKey: AffinityKey | null = null,
): ChainResult {
  return resolveModelChainWithDiagnostics(rawModel, config, affinityKey).result;
}
