/**
 * Canonical model-definition helpers.
 *
 * Every static provider catalog describes the same `ModelDefinition` shape with
 * only a handful of per-provider differences (wire family, endpoint path,
 * vision/reasoning/tool flags, pricing). `defineModel` is the single place that
 * shape is constructed. Catalogs pass only the fields that differ, so a catalog
 * edit cannot silently drift from the shared defaults. Limits and pricing fall
 * back to the prebuilt base catalog; capability does not — see `defineModel`.
 */
import type { WireFamily } from "../transport/canonical-model";
import { modelsDevCatalog } from "./discovery/models-dev-catalog";

/** Billing metadata for one provider model. */
export interface ModelCostDefinition {
  readonly input: number | null;
  readonly output: number | null;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly pricing_model?: "pay-per-use" | "subscription" | "unknown";
}

/**
 * Per-token cost for a plan whose tier is free. Zero is a tier fact owned by
 * the provider (Cline's `free` bucket, mirroring the upstream client's
 * deliberate cost zeroing), not a price copied from the base catalog: the base
 * catalog prices the *underlying* model, which the free tier does not bill.
 */
export const FREE_TIER_COST: ModelCostDefinition = {
  input: 0,
  output: 0,
  pricing_model: "pay-per-use",
};

/** Canonical static metadata for one provider model. */
export interface ModelDefinition {
  readonly modelId: string;
  readonly wireFamily: WireFamily;
  readonly endpointPath: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  /** Explicitly supported reasoning effort scale (e.g. `["minimal", "low", "medium", "high", "xhigh"]`). */
  readonly reasoningEfforts?: readonly string[];
  readonly toolCall: boolean;
  readonly webSearch: boolean;
  readonly cost: ModelCostDefinition;
}

/** Fields accepted by `defineModel`; every field except `id` falls back to the shared default. */
export interface ModelHelperRow {
  readonly id: string;
  /**
   * Canonical provider id this row is served by. Optional only so shared
   * helper rows can omit it; supplying it is what makes base-catalog limits
   * and pricing resolve to the right provider's entry.
   */
  readonly providerId?: string;
  /** Defaults to `"chat"`. */
  readonly wireFamily?: ModelDefinition["wireFamily"];
  /** Defaults to the family's conventional path (`/chat/completions`, `/responses`, `/messages`). */
  readonly endpoint?: string;
  /** Defaults to 128k. */
  readonly ctx?: number | null;
  /** Defaults to 8k. */
  readonly out?: number | null;
  readonly vision?: boolean;
  /** Accepts PDF/plain-file input parts (`document`/`file` canonical kinds). */
  readonly document?: boolean;
  /** Accepts audio input parts. */
  readonly audio?: boolean;
  readonly reasoning?: boolean;
  /** Explicitly supported reasoning effort scale. */
  readonly reasoningEfforts?: readonly string[];
  readonly toolCall?: boolean;
  /** Defaults to false. */
  readonly webSearch?: boolean;
  /**
   * Marks a row served by a free plan tier. Such rows bill zero per token
   * regardless of what the base catalog charges for the underlying model.
   */
  readonly free?: boolean;
}

function defaultEndpoint(wireFamily: ModelDefinition["wireFamily"]): string {
  if (wireFamily === "chat") return "/chat/completions";
  if (wireFamily === "responses") return "/responses";
  return "/messages";
}

/**
 * Model ids whose families speak native OpenAI Responses on every gateway that
 * lists them (GPT-5/6, o3/o4). Verified live: `gpt-5.6-terra` answers on
 * `/v1/responses` in ~2s with its gateway routing prefix intact, and the
 * codex/openai static catalogs already carry these families as responses-wire.
 *
 * Both the static inferhub catalog and the tolerant `/models` discovery path
 * classify wire family from the raw id, so the rule is stated once here: a
 * gateway that lists one of these families must not pin it to the chat wire.
 */
export function isResponsesNativeModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes("gpt-5") || id.includes("gpt-6") || id.includes("/o3") || id.includes("/o4");
}

/**
 * Builds one static catalog row. No empty-id guard: the Anthropic and Claude
 * catalogs intentionally ship empty-id rows, so validation here would break
 * module load.
 *
 * Capability is declared per row and never read from the base catalog. The base
 * catalog is keyed by bare model id, and a bare id maps to many provider rows
 * where only the first survives (`models-dev-catalog.ts`), so a capability read
 * from it can describe a different provider's serving of the same model. What a
 * row does not declare is left to the routing ladder's filter → degrade path
 * rather than guessed from a stranger's metadata.
 */
export function defineModel(row: ModelHelperRow): ModelDefinition {
  const wireFamily = row.wireFamily ?? "chat";
  // `row.providerId` names the provider whose catalog this row belongs to, so
  // limits and cost come from that provider's own base-catalog entry. Without
  // it the lookup falls back to the bare id, which returns `undefined` when the
  // catalog disagrees about that id (428 bare keys disagree on context alone).
  const fallback = row.id ? modelsDevCatalog.resolve(row.providerId ?? "", row.id) : undefined;

  const contextLimit =
    row.ctx !== undefined
      ? row.ctx
      : (fallback?.contextLimit ?? 200_000);

  const outputLimit =
    row.out !== undefined
      ? row.out
      : (fallback?.outputLimit ?? 64_192);

  const cost = row.free ? FREE_TIER_COST : modelsDevCatalog.costFor(row.providerId ?? "", row.id);

  return {
    modelId: row.id,
    wireFamily,
    endpointPath: row.endpoint ?? defaultEndpoint(wireFamily),
    contextLimit,
    outputLimit,
    modalities: {
      input: [
        "text",
        ...(row.vision ? ["image"] : []),
        ...(row.document ? ["document"] : []),
        ...(row.audio ? ["audio"] : []),
      ],
      output: ["text"],
    },
    reasoning: row.reasoning ?? false,
    ...(row.reasoningEfforts !== undefined ? { reasoningEfforts: row.reasoningEfforts } : {}),
    toolCall: row.toolCall ?? true,
    webSearch: row.webSearch ?? false,
    cost,
  };
}

/** Capability metadata persisted for one manually registered model id. */
export interface ManualModelMetadata {
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly webSearch: boolean;
}

/**
 * Resolves capability metadata for a manually registered model id.
 *
 * A manual add performs no upstream probe and has no static catalog row. Its
 * capabilities are therefore declared up front rather than inferred from a
 * `defineModel(...)` entry: tools, vision, and reasoning are always enabled. A
 * false negative here is not cosmetic — capability preflight reads `toolCall`
 * and silently strips `tools` from the request, so a manually added model
 * would appear unable to call tools at all. The prebuilt base catalog still
 * supplies the non-capability facts (context/output limits, cost) when it
 * knows the id.
 */
export function resolveManualModelMetadata(
  providerId: string,
  modelId: string,
): ManualModelMetadata {
  const meta = modelsDevCatalog.resolve(providerId, modelId);
  const catalogInput = meta?.modalities.input ?? [];
  return {
    contextLimit: meta?.contextLimit ?? null,
    outputLimit: meta?.outputLimit ?? null,
    modalities: {
      input: ["text", "image", ...catalogInput.filter((m) => m !== "text" && m !== "image")],
      output: meta?.modalities.output ?? ["text"],
    },
    reasoning: true,
    toolCall: true,
    webSearch: false,
  };
}
