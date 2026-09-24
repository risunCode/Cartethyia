import { createApiKeyAdapter } from "../configured-provider";
import type { ProviderDispatchTarget, ModelDefinition, ProviderAdapter, ProviderDispatchContext } from "../../provider-registry";
import { unwrapProviderToken } from "../../credential-envelope";
import { GatewayError } from "../../../transport/gateway-error";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import { isRecord } from "../../../protocol/primitives";
import { providerBaseUrl } from "../../provider-metadata";
import { getCachedModelDiscovery } from "../../operations/model-discovery-cache";
import { defineModel, FREE_TIER_COST } from "../../model-definition";
import {
  resolveClineClientVersion,
  resolveClineSdkVersion,
  getClineClientVersion,
  getClineSdkVersion,
} from "../../operations/client-versions";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
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
  readonly free?: unknown;
  readonly clinePass?: unknown;
}

function modelEntries(value: unknown): readonly ClineRecommendedModel[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ClineRecommendedModel => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function recommendedModels(value: unknown, pass: boolean): readonly ModelDefinition[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const payload = value as ClineRecommendedPayload;
  const entries = pass
    ? [
        ...modelEntries(payload.clinePass).map((entry) => [entry, true] as const),
        ...modelEntries(payload.free).map((entry) => [entry, false] as const),
      ]
    : modelEntries(payload.free).map((entry) => [entry, false] as const);
  const seen = new Set<string>();
  const out: ModelDefinition[] = [];
  for (const [entry, namespaceForWire] of entries) {
    const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (rawId.length === 0) continue;
    const id =
      namespaceForWire && !rawId.startsWith("cline-pass/")
        ? `cline-pass/${rawId}`
        : rawId;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : id;
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.toLowerCase())
      : [];
    const images = tags.some((tag) => tag.includes("vision") || tag.includes("multimodal"));
    out.push({
      modelId: id,
      wireFamily: "chat",
      endpointPath: CLINE_CHAT_PATH,
      contextLimit: 200_000,
      outputLimit: 64_192,
      modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
      reasoning: true,
      toolCall: true,
      webSearch: false,
      // The recommended-models buckets are the tier authority: `free` entries
      // bill zero, while `clinePass` entries are the subscription roster priced
      // by the base catalog's `cline-pass` provider.
      cost: namespaceForWire ? modelsDevCatalog.costFor("cline-pass", id) : FREE_TIER_COST,
    });
    void name;
    void images;
  }
  return out;
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
      const models = recommendedModels(json, pass);
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

// Static Cline model catalog.


export const CLINE_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    ctx: 1_048_576,
    out: 384_000,
    reasoning: true,
    vision: false,
    free: true,
  }),
  defineModel({
    id: "google/gemma-4-31b-it:free",
    ctx: 262_144,
    out: 131_072,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "deepseek/deepseek-v4-flash",
    ctx: 1_048_576,
    out: 384_000,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "cline-free/deepseek-v4.1-flash",
    ctx: 1_048_576,
    out: 384_000,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "z-ai/glm-5.3-flash",
    ctx: 1_310_720,
    out: 131_072,
    reasoning: true,
    vision: true,
    free: true,
  }),
  defineModel({
    id: "cline-free/muse-spark-1.3-contributor",
    ctx: 1_048_576,
    out: 131_072,
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
      supported_wire_families: ["chat", "responses"],
      buildExtraHeaders: (ctx) => clineExtraHeaders(ctx),
      prePayload: clinePrePayload,
    },
    fetchImpl,
  );
}
