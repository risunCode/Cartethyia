import baseModels from "./base-models.json";

/** Billing metadata from the prebuilt models.dev base catalog. */
export interface ModelsDevModelCost {
  readonly input: number | null;
  readonly output: number | null;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly reasoning?: number;
  readonly pricing_model: "pay-per-use" | "subscription" | "unknown";
}

/** Canonical model metadata from the prebuilt base catalog. */
export interface ModelsDevModelMetadata {
  readonly id: string;
  readonly name?: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly cost: ModelsDevModelCost;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  readonly toolCall: boolean;
}

interface BaseModelRow {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly context: number | null;
  readonly output: number | null;
  readonly input: readonly string[];
  readonly outputModalities: readonly string[];
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly cost: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cache_read?: number;
    readonly cache_write?: number;
    readonly reasoning?: number;
  };
}

const BASE_MODELS = baseModels.models as readonly BaseModelRow[];
const UNKNOWN_COST: ModelsDevModelCost = {
  input: null,
  output: null,
  pricing_model: "unknown",
};

/**
 * Removes a trailing release date from a model id, in either spelling the
 * catalog uses: `-YYYY-MM-DD` (`gpt-4o-2024-11-20`) or `-YYYYMMDD`
 * (`claude-haiku-4-5-20251001`). A dated snapshot bills the same rate as the
 * model it snapshots, so both forms must reach the same row.
 */
function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

function pricingModel(cost: BaseModelRow["cost"]): ModelsDevModelCost["pricing_model"] {
  return cost.input !== null || cost.output !== null ? "pay-per-use" : "unknown";
}

/**
 * How many optional rate fields a row states. Used to keep the most detailed
 * rate when several rows quote the same base price: a row that omits
 * `cache_read` would otherwise make every cached token bill at the full input
 * rate, which is several times the real cost.
 */
function rateCompleteness(cost: ModelsDevModelCost): number {
  let score = 0;
  if (typeof cost.cache_read === "number") score += 1;
  if (typeof cost.cache_write === "number") score += 1;
  if (typeof cost.reasoning === "number") score += 1;
  return score;
}

function toMetadata(row: BaseModelRow): ModelsDevModelMetadata {
  return {
    id: row.id,
    ...(row.name === undefined ? {} : { name: row.name }),
    contextLimit: row.context,
    outputLimit: row.output,
    cost: {
      ...row.cost,
      pricing_model: pricingModel(row.cost),
    },
    modalities: {
      input: row.input,
      output: row.outputModalities,
    },
    reasoning: row.reasoning,
    toolCall: row.toolCall,
  };
}

/**
 * Cartethyia provider id → the provider key models.dev files it under.
 *
 * Only ids that genuinely differ belong here, and each entry is backed by the
 * deployment's own upstream: `opencodeft` serves `opencode.ai/zen/v1`, and 78
 * of its 80 model ids also appear under models.dev's `opencode`. Without this
 * the exact lookup missed for every one of those models, so each fell through
 * to the bare lookup — which fails closed when providers disagree — and the
 * entry was published with invented defaults.
 *
 * Deliberately absent: providers with no models.dev counterpart (a private
 * gateway, a BYOK endpoint) and any id whose match rests on model ids alone.
 * A shared model id is not proof of identity — the same generic id appears
 * under hundreds of resellers — so a guess here would attribute a stranger's
 * limits to this gateway's serving, which is the exact failure this catalog's
 * disagreement rule exists to prevent.
 *
 * This table is for **metadata** (limits, modalities), where a wrong row is
 * harmful and failing closed is right. Pricing does not need it: see
 * `globalCostFor`, which falls back to the model's own rate when the routed
 * provider has none of its own.
 */
const MODELS_DEV_PROVIDER_IDS: Readonly<Record<string, string>> = {
  opencodeft: "opencode",
  opencodezen: "opencode",
  opencodego: "opencode-go",
  ollamacloud: "ollama-cloud",
  xiaomipg: "xiaomi-token-plan-sgp",
  xiaomitp: "xiaomi-token-plan-cn",
};

/**
 * Resolves model metadata and pricing exclusively from the prebuilt base
 * catalog shipped with Cartethyia. Runtime network access is intentionally
 * absent: deployed instances use the exact catalog selected at build time.
 */
export class ModelsDevCatalog {
  private readonly exactMap = new Map<string, ModelsDevModelMetadata>();
  /**
   * Bare id → every row that carried it, not just the first.
   *
   * A bare id is not unique: `claude-sonnet-4-6` appears under 32 providers in
   * the base catalog, and 428 bare keys disagree about `context`, 503 about
   * `output`, and 551 about pricing. Keeping only the first row meant the
   * winner was whichever provider sorted first (`302ai`), so a Cartethyia
   * model could report another reseller's limits and price.
   */
  private readonly bareMap = new Map<string, ModelsDevModelMetadata[]>();
  /**
   * Bare model id → the price the catalog records for the model itself,
   * independent of which provider filed it.
   *
   * Pricing is a property of the model, not of the reseller: a gateway that
   * republishes `grok-4.7` bills the model's rate even though the catalog filed
   * that id under `xai`. Metadata (limits, modalities) stays provider-specific
   * and fail-closed on disagreement — a wrong limit is harmful and optional —
   * but a price is needed for every routed request, and reporting `$0.00` for a
   * paid model is worse than the closest published rate. Where providers
   * disagree the most frequently recorded price wins; a tie resolves to the
   * higher rate, so a reseller's free-tier entry cannot make a paid model look
   * free.
   */
  private readonly globalCostMap = new Map<string, ModelsDevModelCost>();

  constructor(rows: readonly BaseModelRow[] = BASE_MODELS) {
    /** Bare id → price signature → vote, used to build {@link globalCostMap}. */
    const priceVotes = new Map<string, Map<string, { cost: ModelsDevModelCost; count: number }>>();
    for (const row of rows) {
      const metadata = toMetadata(row);
      const provider = row.provider.trim().toLowerCase();
      const modelId = row.id.trim().toLowerCase();
      this.exactMap.set(`${provider}:${modelId}`, metadata);
      const bareId = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
      const bucket = this.bareMap.get(bareId);
      if (bucket) bucket.push(metadata);
      else this.bareMap.set(bareId, [metadata]);

      // Only a fully stated rate is a candidate: a row missing either side
      // states no price at all and must not vote.
      const cost = metadata.cost;
      if (typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      let votes = priceVotes.get(bareId);
      if (votes === undefined) {
        votes = new Map();
        priceVotes.set(bareId, votes);
      }
      // The vote is the base rate (`input/output`), because that is what every
      // row that prices the model agrees or disagrees about. Cache rates are
      // detail layered on top: two rows quoting the same base rate but only one
      // carrying `cache_read`/`cache_write` must not split the vote, or the
      // mode could pick the row that forgot the cache rates and bill every
      // cached token at the full input rate.
      const signature = `${cost.input}/${cost.output}`;
      const existing = votes.get(signature);
      if (existing) {
        existing.count += 1;
        if (rateCompleteness(cost) > rateCompleteness(existing.cost)) existing.cost = cost;
      } else {
        votes.set(signature, { cost, count: 1 });
      }
    }
    for (const [bareId, votes] of priceVotes) {
      let winner: { cost: ModelsDevModelCost; count: number } | undefined;
      for (const vote of votes.values()) {
        if (winner === undefined) {
          winner = vote;
          continue;
        }
        if (vote.count > winner.count) {
          winner = vote;
          continue;
        }
        // Tie: take the dearer rate so a free-tier row never wins by accident.
        const voteTotal = (vote.cost.input ?? 0) + (vote.cost.output ?? 0);
        const winnerTotal = (winner.cost.input ?? 0) + (winner.cost.output ?? 0);
        if (vote.count === winner.count && voteTotal > winnerTotal) winner = vote;
      }
      if (winner) this.globalCostMap.set(bareId, winner.cost);
    }
    // A dated snapshot is the same model at the same rate, and callers may ask
    // for either spelling. Seed the undated form too, without letting it
    // override a rate already recorded for that exact id: the catalog's own
    // undated row (when it has one) stays authoritative.
    for (const [bareId, cost] of [...this.globalCostMap]) {
      const undated = stripDateSuffix(bareId);
      if (undated !== bareId && !this.globalCostMap.has(undated)) {
        this.globalCostMap.set(undated, cost);
      }
    }
  }

  /**
   * Resolves metadata for one model id.
   *
   * An exact `provider:model` hit always wins — it is the only lookup that
   * names the provider actually serving the request. The bare-id fallback is
   * used only when it is **unambiguous**: if the base catalog recorded the id
   * under several providers with different facts, no row can be called the
   * model's own, so the answer is `undefined` and the caller keeps its own
   * declared limits instead of inheriting a stranger's.
   *
   * Callers that know the provider should pass it; passing `""` opts into the
   * bare lookup, which is why it fails closed on disagreement.
   */
  resolve(providerId: string, modelId: string): ModelsDevModelMetadata | undefined {
    const provider = providerId.trim().toLowerCase();
    const normalizedModel = modelId.trim().toLowerCase();
    // Try the id as given, then its models.dev filing name. The mapped name is
    // a second chance, not a replacement: an id that already matches exactly
    // must keep winning, or a future provider added upstream under our own id
    // would be shadowed by the mapping.
    const exact =
      this.exactMap.get(`${provider}:${normalizedModel}`) ??
      this.exactMap.get(`${MODELS_DEV_PROVIDER_IDS[provider] ?? ""}:${normalizedModel}`);
    if (exact) return exact;
    const bareId = normalizedModel.includes("/")
      ? normalizedModel.slice(normalizedModel.indexOf("/") + 1)
      : normalizedModel;
    const bare = this.unambiguousBare(bareId);
    if (bare) return bare;
    const strippedDate = stripDateSuffix(bareId);
    return strippedDate === bareId ? undefined : this.unambiguousBare(strippedDate);
  }

  /**
   * The single row for `bareId`, or `undefined` when the catalog disagrees
   * about it. Two rows that agree on every reported fact are interchangeable,
   * so the first is returned rather than treating agreement as ambiguity.
   */
  private unambiguousBare(bareId: string): ModelsDevModelMetadata | undefined {
    const rows = this.bareMap.get(bareId);
    if (rows === undefined) return undefined;
    const first = rows[0];
    if (first === undefined) return undefined;
    if (rows.length === 1) return first;
    const signature = (m: ModelsDevModelMetadata): string =>
      JSON.stringify([m.contextLimit, m.outputLimit, m.cost, m.modalities]);
    const expected = signature(first);
    for (const row of rows) {
      if (signature(row) !== expected) return undefined;
    }
    return first;
  }

  /**
   * The price to bill for `modelId`, preferring the routed provider's own row.
   *
   * Unlike {@link resolve}, this does **not** fail closed when the provider has
   * no row: a gateway that republishes a model without publishing its own rate
   * still owes a cost, and the model's own global rate is the honest answer.
   * `resolve` keeps its fail-closed metadata rule — a wrong context limit is
   * harmful, while a missing price makes every request on that route read
   * `$0.00` as if it were measured.
   */
  costFor(providerId: string, modelId: string): ModelsDevModelCost {
    if (modelId.trim().length === 0 && providerId.trim().length === 0) return UNKNOWN_COST;
    const own = this.resolve(providerId, modelId)?.cost;
    if (own && (typeof own.input === "number" || typeof own.output === "number")) return own;
    const normalized = modelId.trim().toLowerCase();
    const bareId = normalized.includes("/")
      ? normalized.slice(normalized.indexOf("/") + 1)
      : normalized;
    // The global index carries both spellings of a dated id (see the
    // constructor), so one lookup answers either.
    const global = this.globalCostMap.get(bareId);
    return global ?? own ?? UNKNOWN_COST;
  }
}

export const modelsDevCatalog = new ModelsDevCatalog();
