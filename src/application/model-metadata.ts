import type { ModelCapabilityCategory, ModelContextLimits, ModelMetadata, ModelTokenPricing } from "./contracts";
import { resolveModelChain, type ModelReferenceConfig, type ResolvedModel } from "./routing";

/**
 * Canonical model metadata resolution.
 *
 * One resolver chains the same lookup tables the data plane uses for routing
 * (provider prefixes, aliases, combos) and resolves a raw model name to the
 * normalized metadata of its underlying catalog model(s). Aliases inherit the
 * metadata of their target; combos aggregate member metadata to deterministic
 * upper bounds (max context / max price, unioned categories, "custom" source
 * when any member is custom). Unknown or unresolved references return `null`
 * — callers must treat that as permissive, never fabricate limits or prices.
 */

/** Resolved metadata for one model reference, as surfaced to API/console views. */
export interface ResolvedModelMetadata {
  /** How the raw name was interpreted: direct model, router alias chain, or combo. */
  readonly kind: "model" | "router" | "combo";
  /** Underlying provider-qualified targets (combo members in resolved order). */
  readonly targets: readonly ResolvedModel[];
  readonly context: ModelContextLimits;
  readonly categories: readonly ModelCapabilityCategory[];
  readonly pricing: ModelTokenPricing;
  readonly source: "catalog" | "custom";
  readonly updatedAt: string | null;
}

/** Maps one underlying provider-qualified model to its normalized metadata. */
export type ModelMetadataLookup = (providerId: string, modelId: string) => ModelMetadata | null;

export interface ModelMetadataResolver {
  readonly lookup: ModelMetadataLookup;
  readonly resolve: (rawModel: string) => Promise<ResolvedModelMetadata | null>;
}

const CATEGORY_ORDER: readonly ModelCapabilityCategory[] = ["vision", "text", "reasoning"];

/**
 * Resolves a raw model name (qualified, alias, or combo) to the normalized
 * metadata of its underlying catalog models. Returns null for genuinely
 * unknown or unresolvable references.
 */
export function resolveModelMetadata(
  rawModel: string,
  config: ModelReferenceConfig,
  lookup: ModelMetadataLookup,
): ResolvedModelMetadata | null {
  const chain = resolveModelChain(rawModel, config);
  if (chain.kind === "unresolved") return null;

  const targets: readonly ResolvedModel[] = chain.kind === "qualified" ? [chain.model] : chain.candidates;
  const kind: ResolvedModelMetadata["kind"] = config.aliases.has(rawModel)
    ? "router"
    : config.combos.has(rawModel)
      ? "combo"
      : "model";

  const known = targets
    .map((target) => ({ target, metadata: lookup(target.providerId, target.modelId) }))
    .filter((entry): entry is { readonly target: ResolvedModel; readonly metadata: ModelMetadata } => entry.metadata !== null);
  if (known.length === 0) return null;

  // Single pass over `known` to compute all aggregated fields, avoiding the
  // four separate .map() + .some() + fifth .map() the prior code issued.
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let inputPerMillion: number | null = null;
  let outputPerMillion: number | null = null;
  let latestUpdatedAt: string | null = null;
  let anyCustom = false;
  const presentCategories = new Set<ModelCapabilityCategory>();
  for (const { metadata } of known) {
    const { context: ctx, pricing: pr, categories: cats, source, updatedAt } = metadata;
    if (ctx.inputTokens !== null && (inputTokens === null || ctx.inputTokens > inputTokens)) inputTokens = ctx.inputTokens;
    if (ctx.outputTokens !== null && (outputTokens === null || ctx.outputTokens > outputTokens)) outputTokens = ctx.outputTokens;
    if (pr.inputPerMillion !== null && (inputPerMillion === null || pr.inputPerMillion > inputPerMillion)) inputPerMillion = pr.inputPerMillion;
    if (pr.outputPerMillion !== null && (outputPerMillion === null || pr.outputPerMillion > outputPerMillion)) outputPerMillion = pr.outputPerMillion;
    if (!anyCustom && source === "custom") anyCustom = true;
    if (updatedAt !== null && (latestUpdatedAt === null || updatedAt > latestUpdatedAt)) latestUpdatedAt = updatedAt;
    for (const cat of cats) {
      if (CATEGORY_ORDER.includes(cat)) presentCategories.add(cat);
    }
  }

  return {
    kind,
    targets,
    context: { inputTokens, outputTokens },
    categories: CATEGORY_ORDER.filter((category) => presentCategories.has(category)),
    pricing: { inputPerMillion, outputPerMillion },
    source: anyCustom ? "custom" : "catalog",
    updatedAt: latestUpdatedAt,
  };
}