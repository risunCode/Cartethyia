/**
 * Routing resolver — qualified model parsing, provider target lookup,
 * and model chain resolution (qualified prefix → alias → combo → filter).
 *
 * @see https://cartethyia.dev/resolve
 */

import { providerRegistry } from "../upstream/providers";
import { PROVIDER_PREFIXES } from "./types";
import type { RotationStrategy } from "./strategy";
import type { AddedProviderId, ProviderPrefix, QualifiedModelParseResult, RouteTarget, TargetSurface } from "./types";
import { evaluateFilter, resolveAlias, getComboByName } from "../console/db/repos/combos";
import { isProviderModelEnabled } from "../console/db/repos/provider-models";
import { isCustomProviderSlug } from "../console/db/repos/custom-providers";

type StaticTargetDefinition = {
  provider: AddedProviderId;
  surfaces: Record<string, TargetSurface>;
  credential: RouteTarget["credential"];
};

const STATIC_TARGETS: Record<AddedProviderId, StaticTargetDefinition> = {
  commandcode: {
    provider: "commandcode",
    surfaces: { default: "commandcode-ndjson" },
    credential: "provider-bearer",
  },
  kimchi: {
    provider: "kimchi",
    surfaces: { default: "openai-chat" },
    credential: "provider-bearer",
  },
  "opencode-free": {
    provider: "opencode-free",
    surfaces: { default: "openai-chat" },
    credential: "none",
  },
  "opencode-zen": {
    provider: "opencode-zen",
    surfaces: { default: "openai-chat" },
    credential: "provider-bearer",
  },
  devin: {
    provider: "devin",
    surfaces: { default: "devin-connect" },
    credential: "devin-session",
  },
  // Credential is resolved from the custom_providers row itself (REQ-8), not
  // via account rotation — "none" here just means "nothing for resolveCredentialForDispatch to do".
  custom: {
    provider: "custom",
    surfaces: { default: "openai-chat" },
    credential: "none",
  },
  openai: {
    provider: "openai",
    surfaces: { default: "openai-chat" },
    credential: "provider-bearer",
  },
  anthropic: {
    provider: "anthropic",
    surfaces: { default: "openai-chat" },
    credential: "provider-bearer",
  },
  pgxiaomi: {
    provider: "pgxiaomi",
    surfaces: { default: "openai-chat" },
    credential: "provider-bearer",
  },
  cursor: {
    provider: "cursor",
    surfaces: { default: "openai-chat" },
    credential: "provider-bearer",
  },
  qoder: {
    provider: "qoder",
    surfaces: { default: "openai-chat" },
    credential: "qoder-pat",
  },
  openrouter: { provider: "openrouter", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  ollama: { provider: "ollama", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  cerebras: { provider: "cerebras", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  deepseek: { provider: "deepseek", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  siliconflow: { provider: "siliconflow", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  mistral: { provider: "mistral", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  "opencode-go": { provider: "opencode-go", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  agentrouter: { provider: "agentrouter", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
  tpxiaomi: { provider: "tpxiaomi", surfaces: { default: "openai-chat" }, credential: "provider-bearer" },
};

/** Expected credential kind per provider (REQ-1) — the same table STATIC_TARGETS resolves targets from, so this can never drift from live routing behavior. */
export function credentialKindOf(provider: AddedProviderId): RouteTarget["credential"] {
  return STATIC_TARGETS[provider].credential;
}

export interface RouteResolution {
  target: RouteTarget;
  legacy: false;
}

export type RouteResolveResult = RouteResolution | { legacy: false; error: string; status?: number };

/** Parses an optional provider-qualified model name without changing legacy routing. */
export function parseQualifiedModel(model: string): QualifiedModelParseResult {
  const separatorIndex = model.indexOf("/");
  if (separatorIndex === -1) return { kind: "legacy" };

  const prefix = model.slice(0, separatorIndex);
  const modelId = model.slice(separatorIndex + 1);
  if (!prefix || !modelId) {
    return { kind: "invalid", reason: "Provider-qualified model names must include both a provider prefix and a model ID." };
  }
  if (modelId.split("/").some((segment) => !segment)) {
    return { kind: "invalid", reason: "Provider-qualified model IDs may not contain empty path segments." };
  }
  if (Object.hasOwn(PROVIDER_PREFIXES, prefix)) {
    const provider = PROVIDER_PREFIXES[prefix as ProviderPrefix];
    return { kind: "qualified", model: { provider, modelId } };
  }

  // Not a built-in prefix — a custom provider addresses directly under its
  // own slug (no `custom/` wrapper), so re-attach it to modelId for the
  // internal `custom` provider's `<slug>/<model>` split (dynamic.ts).
  if (isCustomProviderSlug(prefix)) {
    return { kind: "qualified", model: { provider: "custom", modelId: `${prefix}/${modelId}` } };
  }

  return { kind: "invalid", reason: "Use a supported provider prefix such as foc, opencodezen, cmd, kimchi, devin, qoder, cursor, openai, anthropic, pmimo, mimosgtp, agentrouter, openrouter, ollama, cerebras, deepseek, siliconflow, mistral, opencodego, or a custom provider's own slug." };
}

// ─────────────────── Model chain resolution ─────────────────────────────────

/**
 * Resolves the model name through the chain: qualified prefix → alias → combo.
 *
 * Returns a `QualifiedModel` for direct resolution, or an ordered list of
 * `QualifiedModel` candidates for combo dispatch (fallback/round-robin).
 * Returns `null` if the name is genuinely unqualified and has no alias/combo
 * match — the caller should treat this as a legacy (passthrough) model.
 *
 * Limit recursion depth to avoid alias→alias loops; any hit at max depth
 * is treated as a single-model result regardless of whether it names a combo.
 */
export function resolveModelChain(
  rawModel: string,
): { kind: "qualified"; model: { provider: AddedProviderId; modelId: string } } | { kind: "combo"; candidates: Array<{ provider: AddedProviderId; modelId: string }> } | null {
  const MAX_DEPTH = 8;

  const resolveInner = (name: string, depth: number):
    | { kind: "qualified"; model: { provider: AddedProviderId; modelId: string } }
    | { kind: "combo"; candidates: Array<{ provider: AddedProviderId; modelId: string }> }
    | null => {
    if (depth > MAX_DEPTH) return null;

    // 1. Qualified prefix — only accept valid known prefixes; unknown
    //    prefixes (like "anthropic/") should fall through to alias/combo
    //    resolution instead of being rejected outright.
    const parsed = parseQualifiedModel(name);
    if (parsed.kind === "qualified") return { kind: "qualified", model: parsed.model };

    // 2. Alias
    const aliasTarget = resolveAlias(name);
    if (aliasTarget) {
      const resolved = resolveInner(aliasTarget, depth + 1);
      if (resolved) return resolved;
    }

    // 3. Combo
    const combo = getComboByName(name);
    if (combo) {
      const candidates: Array<{ provider: AddedProviderId; modelId: string }> = [];
      // Limit depth on combo member resolution to prevent alias/combo in combo members.
      if (depth < MAX_DEPTH - 1) {
        for (const member of combo.models) {
          const result = resolveInner(member, depth + 1);
          if (result?.kind === "qualified") candidates.push(result.model);
          // Combo members that are themselves combos are collapsed to their qualified entries.
          if (result?.kind === "combo") candidates.push(...result.candidates);
        }
      }
      // Order candidates for fallback/round-robin based on combo strategy.
      return { kind: "combo", candidates: orderedComboCandidates(combo.id, candidates, combo.strategy, combo.stickyLimit) };
    }

    // 4. Not matched
    return null;
  };

  return resolveInner(rawModel, 0);
}

// ─────────────────── Combo candidate ordering ──────────────────────────────

const comboRotState = new Map<string, { index: number; usesLeft: number }>();

function orderedComboCandidates(
  comboId: string,
  candidates: Array<{ provider: AddedProviderId; modelId: string }>,
  strategy: RotationStrategy,
  stickyLimit: number,
): Array<{ provider: AddedProviderId; modelId: string }> {
  if (candidates.length === 0) return candidates;
  if (strategy === "fallback") return candidates;

  // Round-robin with sticky limit
  const limit = stickyLimit > 0 ? stickyLimit : 1;
  const state = comboRotState.get(comboId) ?? { index: 0, usesLeft: limit };
  if (state.index >= candidates.length) state.index = 0;
  if (state.usesLeft <= 0) {
    state.index = (state.index + 1) % candidates.length;
    state.usesLeft = limit;
  }
  state.usesLeft -= 1;
  comboRotState.set(comboId, state);

  const ordered = [];
  for (let i = 0; i < candidates.length; i++) {
    ordered.push(candidates[(state.index + i) % candidates.length]!);
  }
  return ordered;
}

/** Test-only: clear combo rotation state so each test starts from index 0. */
export function invalidateComboRotation(comboId: string): void {
  comboRotState.delete(comboId);
}

export function resetComboRotationForTests(): void {
  comboRotState.clear();
}

// ─────────────────── Async resolution with catalog + filter ────────────────

/** Resolves a qualified model through its provider, including dynamic catalog eligibility. */
export async function resolveQualifiedTarget(model: string): Promise<RouteResolveResult> {
  const parsed = parseQualifiedModel(model);
  if (parsed.kind === "qualified") {
    return resolveSingleQualifiedTarget(parsed.model.provider, parsed.model.modelId);
  }

  const targets = await resolveAllComboTargets(model);
  return targets[0] ?? { legacy: false, error: "No eligible model found in the combo (all filtered or unavailable)." };
}

/**
 * Resolves ALL eligible targets for a model (including combo expansion).
 * For single models, returns a single-element array.
 * For combos, returns all eligible targets in fallback/round-robin order.
 * Used by dispatchQualifiedRoute for combo failover on upstream failure (C6).
 */
export async function resolveAllComboTargets(model: string): Promise<RouteResolveResult[]> {
  // No early rejection on unknown prefixes — let resolveModelChain try
  // Alias/combo resolution runs before direct prefix resolution.
  const chain = resolveModelChain(model);
  if (!chain) return [{ legacy: false, error: "All models must use a supported provider prefix." }];

  if (chain.kind === "qualified") {
    const result = await resolveSingleQualifiedTarget(chain.model.provider, chain.model.modelId);
    return [result];
  }

  // Combo: resolve all eligible targets
  const results: RouteResolveResult[] = [];
  for (const candidate of chain.candidates) {
    const result = await resolveSingleQualifiedTarget(candidate.provider, candidate.modelId);
    if (!result.legacy && !("error" in result)) results.push(result);
  }
  return results;
}

async function resolveSingleQualifiedTarget(providerId: AddedProviderId, modelId: string): Promise<RouteResolveResult> {
  const provider = providerRegistry.get(providerId);
  if (!provider) return { legacy: false, error: "The selected provider is not available." };

  if (!isProviderModelEnabled(providerId, modelId)) {
    return { legacy: false, error: "This model is disabled for the selected provider.", status: 404 };
  }

  // Special: opencode-free has a dynamically-fetched catalog, and "custom"
  // accepts arbitrary upstream model ids per registered endpoint; skip the
  // static model existence check since `resolveTarget` does its own lookup.
  if (providerId !== "opencode-free" && providerId !== "custom" && providerId !== "openai" && providerId !== "anthropic" && !provider.models.resolve(modelId)) {
    return { legacy: false, error: "The requested model is not available for this provider." };
  }

  // Filter check (REQ-21): evaluated before dispatch; deny → 404.
  const filter = evaluateFilter(providerId, modelId);
  if (filter.result === "denied") {
    return { legacy: false, error: filter.reason ?? "Model blocked by filter rule.", status: 404 };
  }

  const target = await provider.resolveTarget(modelId);
  if (!target) return { legacy: false, error: "The requested model is not available for this provider." };
  return { legacy: false, target };
}

/** Resolves an exact upstream model ID to provider target metadata. */
export function lookupStaticTarget(provider: AddedProviderId, modelId: string): RouteTarget | undefined {
  const definition = STATIC_TARGETS[provider];
  const model = providerRegistry.get(provider)?.models.resolve(modelId);
  if (!model) return undefined;

  const surface = definition.surfaces[model.id] ?? definition.surfaces.default;
  if (!surface) return undefined;

  return {
    provider: definition.provider,
    modelId: model.id,
    surface,
    credential: definition.credential,
    weight: 1,
  };
}
