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

export type ChainResult =
  | { readonly kind: "qualified"; readonly model: ResolvedModel }
  | { readonly kind: "combo"; readonly candidates: readonly ResolvedModel[] }
  | { readonly kind: "unresolved" };

/** Recursion cap for alias→alias and alias→combo chains (loops terminate). */
export const MAX_MODEL_CHAIN_DEPTH = 8;

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
 * Expands a combo into its ordered qualified candidates.
 *
 * `resolveMember` resolves one member name (qualified, alias, or nested
 * combo); nested combos are collapsed to their qualified entries. Duplicate
 * targets are dropped (first occurrence wins). "fallback" keeps definition
 * order; "round-robin" applies deterministic rendezvous ordering keyed by
 * the affinity key when `stickyLimit > 0`, otherwise by the combo id.
 */
export function expandCombo(
  combo: ComboDefinition,
  resolveMember: (modelName: string) => ChainResult,
  affinityKey: AffinityKey | null,
): readonly ResolvedModel[] {
  const members: ResolvedModel[] = [];
  for (const member of combo.models) {
    const result = resolveMember(member);
    if (result.kind === "qualified") members.push(result.model);
    else if (result.kind === "combo") members.push(...result.candidates);
    // Members that resolve to "unresolved"/"invalid" (e.g. a typo'd member
    // name or a dangling alias) are intentionally dropped here. The domain
    // layer stays side-effect-free, so there is no operator log; the silent
    // drop keeps a single bad member from failing the whole combo. Callers
    // see the shrink only as a shorter candidate list at dispatch time.
  }

  const seen = new Set<string>();
  const unique = members.filter((model) => {
    const key = `${model.providerId}/${model.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (combo.strategy === "fallback") return unique;

  const sticky = combo.stickyLimit > 0 && affinityKey !== null;
  const orderKey = sticky ? affinityKeyString(affinityKey) : `combo:${combo.id}`;
  return orderByRendezvous(orderKey, unique, (model) => `${model.providerId}/${model.modelId}`);
}

/**
 * Resolves a raw model name through the chain: qualified prefix → alias →
 * combo (members resolved recursively). Returns a single qualified model, an
 * ordered candidate list for combo failover, or "unresolved" when the name
 * is genuinely unqualified and unmatched (callers treat that as passthrough).
 */
export function resolveModelChain(
  rawModel: string,
  config: ModelReferenceConfig,
  affinityKey: AffinityKey | null = null,
): ChainResult {
  const resolveInner = (name: string, depth: number): ChainResult => {
    if (depth > MAX_MODEL_CHAIN_DEPTH) return { kind: "unresolved" };

    const parsed = parseModelReference(name, config.prefixes);
    if (parsed.kind === "qualified") {
      return { kind: "qualified", model: { providerId: parsed.providerId, modelId: parsed.modelId } };
    }

    const aliasTarget = resolveAlias(name, config.aliases);
    if (aliasTarget !== null) {
      const resolved = resolveInner(aliasTarget, depth + 1);
      if (resolved.kind !== "unresolved") return resolved;
    }

    const combo = config.combos.get(name);
    if (combo !== undefined) {
      if (depth >= MAX_MODEL_CHAIN_DEPTH - 1) return { kind: "unresolved" };
      const candidates = expandCombo(combo, (member) => resolveInner(member, depth + 1), affinityKey);
      if (candidates.length === 0) return { kind: "unresolved" };
      return { kind: "combo", candidates };
    }
    return { kind: "unresolved" };
  };

  return resolveInner(rawModel, 0);
}
