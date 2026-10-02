/**
 * Bundled web-search providers.
 *
 * Each entry is a search spec served by the `/v1/search` native route: one
 * `serviceKind: "websearch"` model in the provider's catalog plus a
 * `createSearchAdapter` adapter. The provider ids, base URLs, and credential
 * hints live in `provider-metadata.ts` beside every other bundled identity;
 * this file owns only the per-provider request mapping and response
 * normalization, which is what makes a provider's wire local to one spec.
 *
 * The `devin-search` model id is retained on the Devin provider (which is a
 * chat provider); it is not part of this file.
 */
import type { SearchParams, SearchProviderSpec, SearchRequestInit } from "./search-provider";
import { asRecord, stringField } from "./search-provider";
import { providerBaseUrl } from "../provider-metadata";

function domainFilterParams(filter: readonly string[] | undefined): {
  includes: string[];
  excludes: string[];
} {
  if (!filter || filter.length === 0) return { includes: [], excludes: [] };
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const entry of filter) {
    if (entry.startsWith("-")) excludes.push(entry.slice(1));
    else includes.push(entry);
  }
  return { includes, excludes };
}

/** Exa neural search (`POST /search`, `x-api-key` header). */
function exaRequest(params: SearchParams, token: string): SearchRequestInit {
  const { includes, excludes } = domainFilterParams(params.domainFilter);
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.maxResults,
    type: "auto",
    text: true,
    highlights: true,
  };
  if (includes.length > 0) body.includeDomains = includes;
  if (excludes.length > 0) body.excludeDomains = excludes;
  if (params.searchType === "news") body.category = "news";
  return {
    url: `${providerBaseUrl("exa")}/search`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify(body),
    },
  };
}

function exaNormalize(data: unknown): readonly { title: string; url: string; snippet: string; published_at?: string | null; score?: number | null }[] {
  const record = asRecord(data);
  const items = Array.isArray(record?.results) ? record.results : [];
  return items.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) return [];
    const url = stringField(item, "url");
    if (!url) return [];
    const highlights = Array.isArray(item.highlights) ? item.highlights : [];
    const snippet =
      (typeof highlights[0] === "string" ? highlights[0] : "") ||
      (typeof item.text === "string" ? item.text.slice(0, 300) : "");
    const score = typeof item.score === "number" ? Math.min(1, Math.max(0, item.score)) : null;
    return [
      {
        title: stringField(item, "title"),
        url,
        snippet,
        published_at: typeof item.publishedDate === "string" ? item.publishedDate : null,
        score,
      },
    ];
  });
}

/** Tavily (`POST /search`, bearer). */
function tavilyRequest(params: SearchParams, token: string): SearchRequestInit {
  const { includes, excludes } = domainFilterParams(params.domainFilter);
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.maxResults,
    topic: params.searchType === "news" ? "news" : "general",
  };
  if (includes.length > 0) body.include_domains = includes;
  if (excludes.length > 0) body.exclude_domains = excludes;
  return {
    url: `${providerBaseUrl("tavily")}/search`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
  };
}

function tavilyNormalize(data: unknown): readonly { title: string; url: string; snippet: string; published_at?: string | null; score?: number | null }[] {
  const record = asRecord(data);
  const items = Array.isArray(record?.results) ? record.results : [];
  return items.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) return [];
    const url = stringField(item, "url");
    if (!url) return [];
    const score = typeof item.score === "number" ? Math.min(1, Math.max(0, item.score)) : null;
    return [
      {
        title: stringField(item, "title"),
        url,
        snippet: stringField(item, "content"),
        published_at: typeof item.published_date === "string" ? item.published_date : null,
        score,
      },
    ];
  });
}

/** Brave Web Search (`GET /res/v1/web/search`, `x-subscription-token`). */
function braveRequest(params: SearchParams, token: string): SearchRequestInit {
  const endpoint = params.searchType === "news" ? "/news/search" : "/web/search";
  const query = new URLSearchParams({ q: params.query, count: String(params.maxResults) });
  if (params.country) query.set("country", params.country);
  if (params.language) query.set("search_lang", params.language);
  return {
    url: `${providerBaseUrl("brave")}${endpoint}?${query.toString()}`,
    init: {
      method: "GET",
      headers: { accept: "application/json", "x-subscription-token": token },
    },
  };
}

function braveNormalize(data: unknown): readonly { title: string; url: string; snippet: string; published_at?: string | null }[] {
  const record = asRecord(data);
  const container = asRecord(record?.web) ?? asRecord(record?.news) ?? record;
  const items = Array.isArray(container?.results) ? container.results : [];
  return items.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) return [];
    const url = stringField(item, "url");
    if (!url) return [];
    return [
      {
        title: stringField(item, "title"),
        url,
        snippet: stringField(item, "description"),
        published_at:
          typeof item.page_age === "string"
            ? item.page_age
            : typeof item.age === "string"
              ? item.age
              : null,
      },
    ];
  });
}

/** SearXNG metasearch is deliberately absent: it is a self-hosted service whose
 * origin is operator-specific, and a bundled provider's base URL is a single
 * fixed declaration. A self-hosted instance is a BYOK provider, not a bundled
 * one. */
export const SEARCH_PROVIDER_SPECS = {
  exa: { provider_id: "exa", buildRequest: exaRequest, normalize: exaNormalize },
  tavily: { provider_id: "tavily", buildRequest: tavilyRequest, normalize: tavilyNormalize },
  brave: { provider_id: "brave", buildRequest: braveRequest, normalize: braveNormalize },
} satisfies Readonly<Record<string, SearchProviderSpec>>;

export type SearchProviderId = keyof typeof SEARCH_PROVIDER_SPECS;
