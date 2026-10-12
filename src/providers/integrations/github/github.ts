/**
 * GitHub Copilot adapter.
 *
 * Copilot is an OpenAI-compatible chat surface, but not a fixed one: the API
 * host is per-account and is read out of the Copilot token's `proxy-ep` claim,
 * so an Individual account and an enterprise account post to different hosts.
 * That is why this is a bespoke adapter rather than a declarative spec — the
 * `base_url` a spec carries is fixed at registration, and the routing layer
 * resolves one base URL per provider, not per account.
 *
 * The credential is a `{access, apiHost}` envelope for the same reason the
 * host is not a constant: the value stored at login is the only place the
 * account's host is recorded.
 */
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../model-definition";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../contracts";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../compatible-adapter";
import { providerBaseUrl } from "../../metadata";
import {
  GITHUB_REQUEST_HEADERS,
  parseGithubCredential,
} from "./github-oauth";

export const GITHUB_PROVIDER_ID = "github" as const;

/** Chat surface. The static fallback rows are all chat. */
export const GITHUB_ENDPOINT_PATH = "/chat/completions" as const;

/**
 * Responses surface. Copilot serves some SKUs only on `/responses`, so a
 * discovered row declares this path and the shared pipeline routes the request
 * here rather than failing on the chat endpoint.
 */
export const GITHUB_RESPONSES_ENDPOINT_PATH = "/responses" as const;

/**
 * Long-context tier marker.
 *
 * A request for a SKU whose window is at or above the long-context threshold
 * carries this field so Copilot serves it from the long-context pool. It is a
 * Copilot-specific extension, not an OpenAI field, and the native Anthropic
 * surface rejects it as an unknown top-level key — so it is injected only on
 * the chat and responses wires, and only when the account's own catalog reports
 * a qualifying window.
 */
export const GITHUB_CONTEXT_TIER = "long_context" as const;

/** Context window at or above which the account is served from the long tier. */
export const GITHUB_LONG_CONTEXT_THRESHOLD = 500_000;

/** Copilot model ids excluded from both the fallback and discovered catalogs. */
export const GITHUB_EXCLUDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "copilot-search-c",
  "exec-agent-a",
  "exec-agent-b",
  "exec-agent-c",
  "gpt-5.4-mini-free-auto",
  "gpt-5.6-luna",
  "gpt-5.6-luna-free-auto",
  "gpt-6-luna",
  "kimi-k3",
  "kimi-k3-base",
  "kimi-k3-copilot",
  "mai-code-1-flash-4th",
  "mai-code-1-flash-secondary",
  "mai-code-1-flash-tertiary",
  "mai-code-1.1-flash",
]);

/**
 * Model ids the account's catalog reported at or above the long-context
 * threshold.
 *
 * The request builder needs this fact at dispatch time, where the catalog row
 * is not in reach — `ProviderDispatchTarget` carries the wire family and
 * capability flags, not the context window. Discovery is the only place the
 * account's real window is known, so it records the qualifying ids here and the
 * adapter reads them.
 *
 * Absence is the safe default: a model not recorded here simply does not get
 * the long-context tier, which is the behaviour before this existed. The set is
 * only ever added to, so a later discovery run cannot retract a window the
 * upstream already reported.
 */
const longContextModelIds = new Set<string>();

/** Whether the account's catalog reported `modelId` at the long-context tier. */
export function githubModelUsesLongContext(modelId: string): boolean {
  return longContextModelIds.has(modelId.toLowerCase());
}

/** Records the qualifying ids from one discovery run. */
export function recordGithubLongContextModels(models: readonly ModelDefinition[]): void {
  for (const model of models) {
    if (model.contextLimit !== null && model.contextLimit >= GITHUB_LONG_CONTEXT_THRESHOLD) {
      longContextModelIds.add(model.modelId.toLowerCase());
    }
  }
}

interface CopilotModelOptions {
  readonly vision?: boolean;
  readonly reasoning?: boolean;
}

function copilotModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: CopilotModelOptions = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: GITHUB_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: GITHUB_ENDPOINT_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? false,
    reasoning: options.reasoning ?? false,
    toolCall: true,
  });
}

/**
 * Static fallback catalog.
 *
 * The authoritative list is the account's own `/models` response, which reports
 * exactly which SKUs the subscription may use — so this list is the offline
 * floor, not the truth. It includes models verified reachable on the
 * `vscode-chat` integration. Models that failed reachability checks or are
 * still being tested are deliberately excluded. Limits come from the models.dev
 * base catalog where it knows the id (the ids here are the upstream vendors'
 * own).
 */
export const GITHUB_MODELS: readonly ModelDefinition[] = [
  copilotModel("gpt-4.1", 128_000, 32_768, { vision: true }),
  copilotModel("gpt-4o", 128_000, 16_384, { vision: true }),
  copilotModel("gpt-4o-mini", 128_000, 16_384, { vision: true }),
  copilotModel("gpt-3.5-turbo-0613", 16_385, 4_096),
  // Fireworks-hosted agent SKUs. `billing.restricted_to` on the account's own
  // catalog includes `free`, so they are usable without a paid plan.
  copilotModel("copilot-search-a", 260_000, 16_000),
  copilotModel("copilot-search-b", 260_000, 16_000),
];

/**
 * Adapter that derives its host and headers from the stored credential.
 *
 * `prepareHeaders` and the URL are both corrected rather than rebuilt: payload
 * translation, transport, SSE decoding, and error mapping stay with the shared
 * pipeline, so only the two Copilot-specific facts (the host and the client
 * identity) are supplied here.
 */
class GithubAdapter extends OpenAICompatibleAdapter {
  readonly #fallbackBaseUrl: string;
  /**
   * Transport seam, held here because this adapter issues its own request: the
   * shared config's `fetch` is private, and ignoring it would send a test's
   * injected transport to the real network.
   */
  readonly #fetch: typeof fetch | undefined;

  constructor(fallbackBaseUrl: string, fetchImpl?: typeof fetch) {
    super(
      withBearerAuthentication({
        provider_id: GITHUB_PROVIDER_ID,
        base_url: fallbackBaseUrl,
        endpoint_paths_by_wire_family: {
          chat: GITHUB_ENDPOINT_PATH,
          responses: GITHUB_RESPONSES_ENDPOINT_PATH,
        },
        // The long-context tier is a Copilot request extension, injected only
        // for a model the account's own catalog reported at or above the
        // threshold. `contextTier` is applied after wire translation so it
        // rides on the serialized body the upstream actually reads.
        prePayload: (payload, request, candidate) => {
          if (!githubModelUsesLongContext(request.model)) return;
          // Only the OpenAI-shaped surfaces accept the extension; the native
          // Anthropic surface validates against its own schema and rejects an
          // unknown top-level key. The candidate's wire family decides.
          if (candidate.wire_family !== "chat" && candidate.wire_family !== "responses") return;
          if (payload.contextTier !== undefined) return;
          payload.contextTier = GITHUB_CONTEXT_TIER;
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    );
    this.#fallbackBaseUrl = fallbackBaseUrl;
    this.#fetch = fetchImpl;
  }

  /** The account's host, or the provider default when the credential is unreadable. */
  #baseUrl(context: ProviderDispatchContext): string {
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return this.#fallbackBaseUrl;
    try {
      return `https://${parseGithubCredential(new TextDecoder().decode(secret)).apiHost}`;
    } catch {
      return this.#fallbackBaseUrl;
    }
  }

  protected override async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
    const headers = await super.prepareHeaders(context, request, candidate);
    // The Copilot API rejects a request that does not identify a Copilot
    // client, so these are a protocol requirement. `applyRouteUserAgent` has
    // already run inside the shared pipeline, so the identity is stamped after
    // it and wins — the route-level User-Agent is for generic OpenAI-compatible
    // hosts and would be rejected here.
    Object.assign(headers, GITHUB_REQUEST_HEADERS);
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return headers;
    try {
      const { access } = parseGithubCredential(new TextDecoder().decode(secret));
      headers.authorization = `Bearer ${access}`;
    } catch {
      // Left as the factory sent it: the request fails closed at the upstream
      // auth boundary, and the parse error belongs to the credential boundary.
    }
    return headers;
  }

  protected override async executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    _request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ): Promise<Response> {
    // The host comes from the credential, which the shared config cannot see,
    // so the request is issued here against the resolved base URL instead of
    // the registered one. Everything else — the payload, the headers, the
    // deadline lifecycle — is what the shared pipeline produced.
    const endpointPath = candidate?.endpoint_path && candidate.endpoint_path.length > 0
      ? candidate.endpoint_path
      : GITHUB_ENDPOINT_PATH;
    const url = `${this.#baseUrl(context).replace(/\/+$/, "")}${endpointPath}`;
    const outboundFetch = context.outbound_fetch ?? this.#fetch ?? globalThis.fetch;
    const { postUpstreamJson } = await import("../../../protocol/upstream/post-json");
    const upstream = await postUpstreamJson(url, headers, payload as Record<string, unknown>, context, outboundFetch);
    upstream.release();
    return upstream.res;
  }
}

/** GitHub Copilot provider adapter. */
export const githubAdapter: ProviderAdapter = new GithubAdapter(
  providerBaseUrl(GITHUB_PROVIDER_ID),
);
