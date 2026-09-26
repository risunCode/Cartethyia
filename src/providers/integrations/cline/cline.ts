import { createApiKeyAdapter } from "../configured-provider";
import type { ProviderDispatchTarget, ModelDefinition, ProviderAdapter, ProviderDispatchContext } from "../../provider-registry";
import { unwrapProviderToken } from "../../credential-envelope";
import { GatewayError } from "../../../transport/gateway-error";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import { isRecord } from "../../../protocol/primitives";
import { providerBaseUrl } from "../../provider-metadata";
import { getCachedModelDiscovery } from "../../operations/model-discovery-cache";
import { defineModel } from "../../model-definition";
import {
  resolveClineClientVersion,
  resolveClineSdkVersion,
  getClineClientVersion,
  getClineSdkVersion,
} from "../../operations/client-versions";
export {
  getClineClientVersion,
  getClineSdkVersion,
  refreshClineClientVersion,
  resolveClineClientVersion,
  resolveClineSdkVersion,
} from "../../operations/client-versions";
export const CLINE_BASE_URL = providerBaseUrl("cline");
export const CLINE_PROVIDER_ID = "cline" as const;
const CLINE_CHAT_PATH = "/chat/completions" as const;
const CLINE_RECOMMENDED_MODELS_PATH = "/ai/cline/recommended-models" as const;
/**
 * Cline's own model catalog. Unlike the roster above it states `context_length`
 * and `top_provider.max_completion_tokens`, so it is the authority for limits.
 */
const CLINE_MODELS_CATALOG_PATH = "/ai/cline/models" as const;



export function workosToken(token: string): string {
  return token.startsWith("workos:") ? token : `workos:${token}`;
}

// Cartethyia expresses this as a per-dispatch buildExtraHeaders hook so every
// request gets fresh client-version headers.
// API-key credentials use direct Bearer format (no workos prefix);
// OAuth and scoped credentials retain the required workos: prefix.

async function clineExtraHeaders(context: ProviderDispatchContext): Promise<Record<string, string>> {
  let authOverride: Record<string, string> = {};
  const secret = context.credential.secret;
  if (secret && secret.length > 0) {
    const raw = new TextDecoder().decode(secret).trim();
    if (raw.length > 0) {
      // Bearer-strip delegates to the single token-envelope implementation.
      const normalized = new TextDecoder().decode(unwrapProviderToken(raw, "bearer"));
      const kind = context.credential.credential_kind;
      const token = kind === "api_key" ? normalized : workosToken(normalized);
      authOverride = { authorization: `Bearer ${token}` };
    }
  }
  // Await discovery so the true latest client/SDK version is stamped on every
  // dispatch; the pinned fallback only applies on a real network failure. The
  // underlying fetch is deduped and TTL-cached (see provider-version-cache).
  await Promise.all([resolveClineClientVersion(), resolveClineSdkVersion()]);
  const clientVersion = getClineClientVersion();
  const sdkVersion = getClineSdkVersion();

  return {
    ...authOverride,
    "user-agent": `Cline/${clientVersion}`,
    // Referer travels in both spellings; some upstream checks are case-sensitive.
    "http-referer": "https://cline.bot",
    "HTTP-Referer": "https://cline.bot",
    "x-platform": process.platform || "unknown",
    "x-platform-version": process.version || "unknown",
    "x-title": "Cline",
    "x-client-type": "cline-sdk",
    "x-client-version": clientVersion,
    "x-core-version": sdkVersion,
    "X-Title": "Cline",
    "x-is-multi-root": "false",
    accept: "text/event-stream, application/json",
  };
}

// System-prompt injection and materialized-stream handling.
// Cline requires a system/developer message for compatibility; its upstream
// free models also reject empty system content, so the fallback is concise.

function clinePrePayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
): void {
  // 1) Ensure system/developer messages always carry non-empty content.
  const rawMessages = payload["messages"];
  const messages: Record<string, unknown>[] = Array.isArray(rawMessages)
    ? rawMessages.filter(isRecord).map((message) => {
        const role = message["role"];
        const content = message["content"];
        const emptyContent =
          content === undefined ||
          content === null ||
          (typeof content === "string" && content.trim().length === 0) ||
          (Array.isArray(content) && content.length === 0);
        return (role === "system" || role === "developer") && emptyContent
          ? { ...message, content: "You are a helpful assistant." }
          : message;
      })
    : [];
  const hasSystem = messages.some(
    (message) => message["role"] === "system" || message["role"] === "developer",
  );
  payload["messages"] = hasSystem
    ? messages
    : [{ role: "system", content: "You are a helpful assistant." }, ...messages];

  // 2) Materialize deepseek-v4-flash non-stream quirk
  const model = typeof payload["model"] === "string" ? (payload["model"] as string) : candidate.model_id;
  const needsMaterialize = !request.stream && model.includes("deepseek-v4-flash");
  if (needsMaterialize) {
    payload["stream"] = true;
    // Set reasoning_effort to none for this model to suppress reasoning streaming
    payload["reasoning_effort"] = "none";
    const cur = typeof payload["max_tokens"] === "number" ? (payload["max_tokens"] as number) : 0;
    payload["max_tokens"] = Math.max(cur, 256);
    // keep GatewayError reachable
    if (!model) throw new GatewayError("invalid_request", 400, "Cline model is required");
  }
}

// (modelEntries / recommendedModels / fetchRecommendedModels) preserved
// as Cartethyia discovery helpers. The factory's discovery endpoint is wired
// to /ai/cline/recommended-models; these helpers can be used by a custom
// discovery layer or tests. Keeping them guarantees the custom tag→vision
// logic and clinePass vs free branching are not lost in the port.

interface ClineRecommendedModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
}

interface ClineRecommendedPayload {
  readonly recommended?: unknown;
  readonly free?: unknown;
  readonly clinePass?: unknown;
  readonly clineCloud?: unknown;
}

function modelEntries(value: unknown): readonly ClineRecommendedModel[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ClineRecommendedModel => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function recommendedModels(
  value: unknown,
  pass: boolean,
  upstream: ReadonlyMap<string, ClineUpstreamLimits> = new Map(),
): readonly ModelDefinition[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const payload = value as ClineRecommendedPayload;
  // The endpoint publishes four buckets: `recommended` (the current picks),
  // `free` (the zero-cost tier), `clinePass` (the subscription roster) and
  // `clineCloud` (cloud-routed). A pass-enabled account may use every one of
  // them, so all four are read; a free account sees the free tier only. Reading
  // just `free`/`clinePass` silently dropped `recommended` and `clineCloud`
  // from the catalog entirely.
  //
  // The third element marks the zero-cost tier — the `free` bucket alone, not
  // `recommended`: a pass account receives `recommended` too, so calling it a
  // free-tier row would mislabel a subscription catalog entry. The tier is what
  // separates a "Free models (auto)" row from an ordinary fetched one.
  //
  // Membership of the bucket *is* the rule, deliberately not the id prefix. The
  // `free` bucket's ids are mostly `cline-free/…`, but the prefix does not
  // define the tier in either direction: a free id need not carry it (the
  // catalog serves `deepseek/deepseek-v4-flash` and `z-ai/glm-5.3-flash` on the
  // free tier with no prefix at all), and carrying it proves nothing on its own.
  // A prefix test would therefore both miss served models and admit retired
  // ones, so the bucket the endpoint already sorted them into is the authority.
  const buckets: ReadonlyArray<readonly [unknown, boolean, boolean]> = pass
    ? [
        [payload.recommended, false, false],
        [payload.free, false, true],
        [payload.clinePass, true, false],
        [payload.clineCloud, true, false],
      ]
    : [
        [payload.recommended, false, false],
        [payload.free, false, true],
      ];
  const seen = new Set<string>();
  const out: ModelDefinition[] = [];
  for (const [bucket, subscription, freeTier] of buckets) {
    for (const entry of modelEntries(bucket)) {
      const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
      if (rawId.length === 0) continue;
      // The endpoint already namespaces its own ids (`cline-pass/…`,
      // `cline-cloud/…`, `cline-free/…`), so the bucket decides only how the
      // row is priced and which catalog entry answers for it — never how the id
      // is spelled. Prefixing here double-namespaced every id the endpoint had
      // already prefixed (`cline-pass/cline-pass/mimo-v2.6-flash`), which no
      // upstream route resolves.
      const id = rawId;
      if (seen.has(id)) continue;
      seen.add(id);
      // Limits, in authority order:
      //   1. Cline's own `/ai/cline/models` catalog (`context_length`,
      //      `top_provider.max_completion_tokens`) — the serving provider's
      //      answer, and the only source that covers the whole roster.
      //   2. `defineModel`'s fallback, which is the base catalog's exact row
      //      when models.dev files the provider (`cline-pass`), else the
      //      most-agreed row for the bare id, else the documented default.
      // The recommended-models endpoint itself states no limits (only
      // id/name/description/tags), so a fixed pair here was simply invented:
      // the pass entries are 1M-context, and an output cap above the real
      // window is unsatisfiable.
      const providerId = subscription ? "cline-pass" : "cline";
      const limits = upstreamLimitsFor(upstream, id);
      const declaredVision = tagsOf(entry).some(
        (tag) => tag.includes("vision") || tag.includes("multimodal"),
      );
      out.push(
        defineModel({
          id,
          providerId,
          wireFamily: "chat",
          endpoint: CLINE_CHAT_PATH,
          // The upstream catalog's `input_modalities` is authoritative when it
          // lists the id; the roster's own tags are the fallback signal.
          vision: limits?.vision ?? declaredVision,
          ...(limits?.contextLimit === undefined ? {} : { ctx: limits.contextLimit }),
          ...(limits?.outputLimit === undefined ? {} : { out: limits.outputLimit }),
          reasoning: true,
          // Two separate statements, so neither has to bend for the other: the
          // free tier and the pass roster both bill zero per token, while only
          // the free bucket is the tier the model list groups as free.
          free: !subscription,
          freeTier,
        }),
      );
    }
  }
  return out;
}

/**
 * Upstream limits for one model id, read from Cline's own catalog.
 *
 * The recommended-models roster states no limits at all, but Cline's
 * `/ai/cline/models` catalog does: `context_length` plus
 * `top_provider.max_completion_tokens`, and `architecture.input_modalities`.
 * That is the serving provider's own answer, so it outranks any guess.
 *
 * The two endpoints do not share an id spelling. The roster names a
 * subscription model `cline-pass/kimi-k3` while the catalog files it as
 * `moonshotai/kimi-k3`, so a lookup tries the id as given and then its bare
 * segment — the same bare-id rule `modelsDevCatalog` uses, and safe here
 * because this is one provider's catalog rather than a shared global index.
 */
interface ClineUpstreamLimits {
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  readonly vision?: boolean;
}

function upstreamCatalogIndex(value: unknown): ReadonlyMap<string, ClineUpstreamLimits> {
  const root = isRecord(value) ? value : undefined;
  const rows = Array.isArray(root?.["data"]) ? root["data"] : Array.isArray(value) ? value : [];
  const byId = new Map<string, ClineUpstreamLimits>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = typeof row["id"] === "string" ? row["id"].trim().toLowerCase() : "";
    if (id.length === 0) continue;
    const contextLimit = positiveCount(row["context_length"]);
    const topProvider = isRecord(row["top_provider"]) ? row["top_provider"] : undefined;
    const outputLimit = positiveCount(topProvider?.["max_completion_tokens"]);
    const architecture = isRecord(row["architecture"]) ? row["architecture"] : undefined;
    const modalities = Array.isArray(architecture?.["input_modalities"])
      ? architecture["input_modalities"]
      : [];
    const limits: ClineUpstreamLimits = {
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }),
      vision: modalities.some((m) => m === "image"),
    };
    byId.set(id, limits);
    // The roster and this catalog spell the same model differently: the roster
    // names a subscription model `cline-pass/kimi-k3` while this catalog files
    // it as `moonshotai/kimi-k3`. Indexing the bare segment too is what lets
    // `upstreamLimitsFor` resolve one to the other. An exact key already
    // recorded stays authoritative, so a provider-prefixed row never shadows a
    // row filed under the bare id itself.
    const slash = id.indexOf("/");
    if (slash >= 0) {
      const bare = id.slice(slash + 1);
      if (!byId.has(bare)) byId.set(bare, limits);
    }
  }
  return byId;
}

function positiveCount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** The catalog row for `id`, falling back to its bare segment. */
function upstreamLimitsFor(
  index: ReadonlyMap<string, ClineUpstreamLimits>,
  id: string,
): ClineUpstreamLimits | undefined {
  const normalized = id.trim().toLowerCase();
  const exact = index.get(normalized);
  if (exact !== undefined) return exact;
  const slash = normalized.indexOf("/");
  return slash < 0 ? undefined : index.get(normalized.slice(slash + 1));
}

function tagsOf(entry: ClineRecommendedModel): readonly string[] {
  return Array.isArray(entry.tags)
    ? entry.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.toLowerCase())
    : [];
}

export async function fetchClineRecommendedModels(
  signal: AbortSignal | undefined,
  pass: boolean,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<readonly ModelDefinition[] | null> {
  const load = async (): Promise<readonly ModelDefinition[] | null> => {
    const timeout = AbortSignal.timeout(10_000);
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const url = `${CLINE_BASE_URL}${CLINE_RECOMMENDED_MODELS_PATH}`;
      const res = await fetcher(url, { headers: { accept: "application/json" }, signal: composed });
      if (!res.ok) return null;
      const json = (await res.json()) as unknown;
      // The limits live in the sibling catalog, not in the roster. Fetch it
      // alongside, and treat its absence as "no upstream limits" rather than a
      // failure: the roster is still useful without them, and `defineModel`
      // falls back to the base catalog.
      const upstream = await fetchClineUpstreamCatalog(fetcher, composed);
      const models = recommendedModels(json, pass, upstream);
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  };
  // The default fetcher is the production path: this roster is public and
  // changes slowly, so a short TTL avoids redundant refreshes. A caller that
  // injects its own fetcher (tests, custom egress) always gets a live call.
  if (fetcher !== globalThis.fetch) return load();
  return getCachedModelDiscovery(`cline-recommended:${pass ? "pass" : "free"}`, load);
}

/** Cline's model catalog, indexed for limit lookup. Empty when unavailable. */
async function fetchClineUpstreamCatalog(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ClineUpstreamLimits>> {
  try {
    const res = await fetcher(`${CLINE_BASE_URL}${CLINE_MODELS_CATALOG_PATH}`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) return new Map();
    return upstreamCatalogIndex(await res.json());
  } catch {
    return new Map();
  }
}

/**
 * Static seed for Cline's free tier.
 *
 * Every id here is materialized into the `models` table at boot with
 * `source: "builtin"`, and `seedBundledModels` deletes any builtin row this
 * list no longer declares. That makes the list the *owner* of these rows: an id
 * Cline retires from its roster keeps its catalog card — and its route — until
 * it is removed here, because nothing else prunes a builtin row. The seed is
 * therefore kept to ids Cline currently serves on the free tier; a stale entry
 * is a card that can only ever fail a probe.
 *
 * Cline's live roster (`/ai/cline/recommended-models`, read by
 * `fetchClineRecommendedModels`) is the authority for what is routable right
 * now, and "Fetch models" reconciles against it. This list is the offline seed
 * that makes a fresh install usable before the first fetch.
 */
export const CLINE_MODELS: readonly ModelDefinition[] = [
  // `deepseek/deepseek-v4-flash` is servable on the free tier even though the
  // roster's `free` bucket does not list it — the bucket is not the whole tier.
  // It is routed and answers for a free account, so it belongs here.
  defineModel({
    id: "deepseek/deepseek-v4-flash",
    ctx: 1_048_576,
    out: 384_000,
    reasoning: true,
    vision: true,
    free: true,
  }),
  // The `free` bucket's own ids, as `/ai/cline/recommended-models` publishes
  // them. Two of the bucket's ids carry no `cline-free/` prefix — the bucket is
  // the tier, the id prefix never was.
  defineModel({
    id: "stealth/pixel-canary",
    ctx: 200_000,
    out: 64_192,
    reasoning: true,
    free: true,
  }),
  defineModel({
    id: "stealth/space-bunny-alpha",
    ctx: 1_000_000,
    out: 524_288,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "cline-free/mimo-v2.6-flash",
    ctx: 1_048_576,
    out: 131_072,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "cline-free/deepseek-v4.1-flash",
    ctx: 1_048_576,
    out: 131_072,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "cline-free/gemini-3.8-flash",
    ctx: 1_048_576,
    out: 65_536,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "cline-free/muse-spark-1.3-contributor",
    ctx: 1_048_576,
    out: 943_718,
    reasoning: true,
    vision: true,
    free: true,
  }),
];


export function createClineAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return createApiKeyAdapter(
    {
      provider_id: CLINE_PROVIDER_ID,
      base_url: CLINE_BASE_URL,
      endpoint_paths_by_wire_family: { chat: CLINE_CHAT_PATH, responses: "/responses" },
      buildExtraHeaders: (ctx) => clineExtraHeaders(ctx),
      prePayload: clinePrePayload,
    },
    fetchImpl,
  );
}
