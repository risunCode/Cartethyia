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

function pricingModel(cost: BaseModelRow["cost"]): ModelsDevModelCost["pricing_model"] {
  return cost.input !== null || cost.output !== null ? "pay-per-use" : "unknown";
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
 * `claude` and `gemini` are here on the same evidence: each is the *same
 * upstream* as its catalog key, not a look-alike id. `claude` and `anthropic`
 * both declare `baseUrl: https://api.anthropic.com` (provider-metadata.ts) and
 * serve the Messages wire — the [CC] impersonation adapter and the plain
 * API-key adapter are two credential paths to one API. `gemini` declares
 * `https://generativelanguage.googleapis.com`, Google's own Gemini endpoint,
 * and its runtime ids (`gemini-2.5-pro`, `gemini-3-flash-preview`, ...) are
 * exactly the ids the catalog files under `google`. Before these two entries
 * every model on both providers priced at zero.
 *
 * Deliberately absent: providers with no models.dev counterpart (a private
 * gateway, a BYOK endpoint) and any id whose match rests on model ids alone.
 * A shared model id is not proof of identity — the same generic id appears
 * under hundreds of resellers — so a guess here would attribute a stranger's
 * limits to this gateway's serving, which is the exact failure this catalog's
 * disagreement rule exists to prevent. That is why reseller-style ids (`codex`
 * on chatgpt.com, `grok` on xAI's CLI proxy, `antigravity` on Cloud Code,
 * `cb`/`cbcn`/`workbuddy`/`qoder`/`commandcode`/`inferhub`/`tokenharbor` on
 * their own gateways) are still absent even though many of their model ids
 * appear elsewhere in the catalog: the upstream differs, so the price may too.
 */
const MODELS_DEV_PROVIDER_IDS: Readonly<Record<string, string>> = {
  claude: "anthropic",
  gemini: "google",
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

  constructor(rows: readonly BaseModelRow[] = BASE_MODELS) {
    for (const row of rows) {
      const metadata = toMetadata(row);
      const provider = row.provider.trim().toLowerCase();
      const modelId = row.id.trim().toLowerCase();
      this.exactMap.set(`${provider}:${modelId}`, metadata);
      const bareId = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
      const bucket = this.bareMap.get(bareId);
      if (bucket) bucket.push(metadata);
      else this.bareMap.set(bareId, [metadata]);
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
    const strippedDate = bareId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
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

  costFor(providerId: string, modelId: string): ModelsDevModelCost {
    if (modelId.trim().length === 0 && providerId.trim().length === 0) return UNKNOWN_COST;
    return this.resolve(providerId, modelId)?.cost ?? UNKNOWN_COST;
  }
}

export const modelsDevCatalog = new ModelsDevCatalog();
