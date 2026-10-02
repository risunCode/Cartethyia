/**
 * Declarative web-search provider adapters.
 *
 * A search provider is a bundled provider whose catalog carries one
 * `serviceKind: "websearch"` model and whose adapter implements the optional
 * `ProviderAdapter.websearch` method. The `/v1/search` native route resolves the
 * caller's `model` through the ordinary routing engine (so aliases and combos of
 * search providers work for free), leases an account, and calls this method.
 *
 * The spec is data plus two pure functions: `buildRequest` maps the caller's
 * opaque search body onto the provider's own HTTP request, and `normalize` maps
 * that provider's response JSON into the shared `WebSearchResult` vocabulary.
 * Keeping both beside the spec means the route never learns a provider's wire,
 * and a new search provider is one spec row plus one metadata/registry entry.
 */
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ProviderId,
  WebSearchOutcome,
  WebSearchResult,
} from "../provider-registry";
import { GatewayError } from "../../transport/gateway-error";
import { readCredentialSecret } from "../provider-registry";

/** Caller-facing search parameters, already validated by the route. */
export interface SearchParams {
  readonly query: string;
  readonly maxResults: number;
  readonly searchType: "web" | "news";
  readonly country?: string;
  readonly language?: string;
  readonly timeRange?: string;
  readonly domainFilter?: readonly string[];
}

/** One upstream request, ready to fetch. */
export interface SearchRequestInit {
  readonly url: string;
  readonly init: RequestInit;
}

/** Declarative description of one web-search provider. */
export interface SearchProviderSpec {
  readonly provider_id: ProviderId;
  /** Builds the provider's request for one query; `token` is the resolved credential secret. */
  readonly buildRequest: (params: SearchParams, token: string) => SearchRequestInit;
  /** Maps the provider's own response JSON into normalized results. */
  readonly normalize: (data: unknown) => readonly WebSearchResult[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

/** Reads the caller's validated search parameters back out of the opaque body. */
export function searchParamsFromBody(body: Record<string, unknown>): SearchParams {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query.length === 0)
    throw new GatewayError("invalid_request", 400, "search query is required");
  const rawMax = body.max_results;
  const maxResults =
    typeof rawMax === "number" && Number.isFinite(rawMax)
      ? Math.min(Math.max(1, Math.floor(rawMax)), 50)
      : 10;
  const searchType = body.search_type === "news" ? "news" : "web";
  const domainFilter = Array.isArray(body.domain_filter)
    ? body.domain_filter.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    query,
    maxResults,
    searchType,
    ...(typeof body.country === "string" && body.country.length > 0 ? { country: body.country } : {}),
    ...(typeof body.language === "string" && body.language.length > 0 ? { language: body.language } : {}),
    ...(typeof body.time_range === "string" && body.time_range.length > 0
      ? { timeRange: body.time_range }
      : {}),
    ...(domainFilter && domainFilter.length > 0 ? { domainFilter } : {}),
  };
}

/**
 * Builds a `ProviderAdapter` for one search spec.
 *
 * `dispatch` is required by the adapter boundary but a search-only provider
 * serves no chat wire, so it fails closed with `capability_unsupported` rather
 * than silently posting a canonical request to a search endpoint.
 */
export function createSearchAdapter(spec: SearchProviderSpec): ProviderAdapter {
  return {
    provider_id: spec.provider_id,
    dispatch(): AsyncIterable<never> {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `${spec.provider_id} serves web search, not a chat wire`,
      );
    },
    async websearch(
      body: Record<string, unknown>,
      _candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): Promise<WebSearchOutcome> {
      const params = searchParamsFromBody(body);
      const token = readCredentialSecret(context.credential);
      const { url, init } = spec.buildRequest(params, token);
      const outboundFetch = context.outbound_fetch ?? globalThis.fetch;
      let res: Response;
      try {
        res = await outboundFetch(url, { ...init, signal: context.abort_signal });
      } catch (error) {
        // A network failure is retryable platform unavailability, not a client
        // error — surfacing it as such lets the attempt loop fail over.
        throw new GatewayError(
          "platform_unavailable",
          502,
          `${spec.provider_id} search unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new GatewayError(
          res.status >= 500 ? "platform_unavailable" : "invalid_request",
          res.status,
          `${spec.provider_id} search error: ${detail.slice(0, 240)}`,
        );
      }
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new GatewayError(
          "platform_unavailable",
          502,
          `${spec.provider_id} search returned an unparseable body`,
        );
      }
      const results = spec.normalize(data);
      return { results, total_results: results.length };
    },
  };
}

export { asRecord, stringField };
