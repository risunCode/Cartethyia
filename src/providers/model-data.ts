import { MODEL_DATA } from "./model-data.generated";
import type { ModelContextLimits, ModelTokenPricing } from "../domain/contracts";

/**
 * On-demand catalog data lookup (context window + token pricing) sourced from
 * models.dev. The generated module is a small, trimmed map of only the models
 * this repo's catalogs actually declare; it is imported once (inherent module
 * caching) and each lookup is a single O(1) map read keyed by `provider/model`
 * — there is no per-request iteration over the source data.
 *
 * Unknown or unmatched references return `null` so callers can stay permissive
 * and never fabricate limits or prices (the same contract as resolveModelMetadata).
 */

/** Repo provider id → models.dev provider id where they differ. */
const PROVIDER_ALIAS: Readonly<Record<string, string>> = {
  gemini: "google",
  codex: "openai",
};

export interface CatalogModelData {
  readonly context: ModelContextLimits;
  readonly pricing: ModelTokenPricing;
}

/** Resolves a repo (providerId, modelId) pair to a models.dev provider/model pair. */
function devRef(providerId: string, modelId: string): { p: string; m: string } | null {
  let p = providerId;
  let m = modelId;
  const slash = modelId.indexOf("/");
  if (slash !== -1) {
    p = modelId.slice(0, slash);
    m = modelId.slice(slash + 1);
  }
  p = PROVIDER_ALIAS[p] ?? p;
  if (p.length === 0 || m.length === 0) return null;
  return { p, m };
}

/**
 * Extracts the last path segment of a model id — the part after the final `/`.
 * Used as a fallback match key when an exact `provider/model` lookup misses,
 * because gateway and router providers (e.g. Blackbox) nest upstream model
 * ids under multiple prefix segments (`blackboxai/z-ai/glm-5.2`) while
 * models.dev keys the same data under the canonical provider (`zai/glm-5.2`).
 */
function lastSegment(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

/**
 * Strips common provider-suffix variants from a model id's last segment so
 * that `glm-5.2-vercel` matches `glm-5.2`, `gpt-5.5-free` matches `gpt-5.5`,
 * etc. Only the trailing `-word` after a known base is removed.
 */
const FUZZY_SUFFIXES = ["-vercel", "-free", "-fast", "-lite", "-preview", "-turbo"] as const;

/** Returns a fuzzy-stripped version of a model last-segment, or null if no strip applied. */
function fuzzyStrip(segment: string): string | null {
  for (const suffix of FUZZY_SUFFIXES) {
    if (segment.endsWith(suffix) && segment.length > suffix.length) {
      return segment.slice(0, -suffix.length);
    }
  }
  return null;
}

/**
 * O(1) lookup of models.dev context/pricing for a repo catalog model.
 *
 * Resolution order:
 * 1. Exact `provider/model` — the normal path for built-in catalog models.
 * 2. Last-segment fallback — match any generated key whose model segment
 *    equals the last segment of `modelId`. This lets fetched/gateway models
 *    (`blackboxai/z-ai/glm-5.2`) inherit global pricing from the canonical
 *    upstream entry (`zai/glm-5.2`) without hand-maintaining per-model data.
 *    The first match wins; this is a deliberate "global pricing" trade-off.
 * 3. Fuzzy suffix strip — if the last segment ends with a common variant
 *    suffix (`-vercel`, `-free`, `-fast`, …), retry matching with the suffix
 *    removed so `glm-5.2-vercel` inherits from `glm-5.2`.
 */
export function lookupModelData(providerId: string, modelId: string): CatalogModelData | null {
  const ref = devRef(providerId, modelId);
  if (ref !== null) {
    const entry = MODEL_DATA[`${ref.p}/${ref.m}`];
    if (entry !== undefined) {
      return {
        context: { inputTokens: entry.context.input, outputTokens: entry.context.output },
        pricing: { inputPerMillion: entry.pricing.input, outputPerMillion: entry.pricing.output },
      };
    }
  }

  // Last-segment fallback: scan for a generated key whose model segment
  // matches the tail of the requested model id.
  const tail = lastSegment(modelId);
  if (tail.length > 0 && tail !== modelId) {
    for (const key of Object.keys(MODEL_DATA)) {
      if (lastSegment(key) === tail) {
        const entry = MODEL_DATA[key]!;
        return {
          context: { inputTokens: entry.context.input, outputTokens: entry.context.output },
          pricing: { inputPerMillion: entry.pricing.input, outputPerMillion: entry.pricing.output },
        };
      }
    }
  }

  // Fuzzy suffix strip: retry last-segment matching with common variant
  // suffixes removed (e.g. `glm-5.2-vercel` → `glm-5.2`).
  const stripped = fuzzyStrip(tail);
  if (stripped !== null) {
    for (const key of Object.keys(MODEL_DATA)) {
      if (lastSegment(key) === stripped) {
        const entry = MODEL_DATA[key]!;
        return {
          context: { inputTokens: entry.context.input, outputTokens: entry.context.output },
          pricing: { inputPerMillion: entry.pricing.input, outputPerMillion: entry.pricing.output },
        };
      }
    }
  }

  return null;
}
