/**
 * Bundled web-search providers.
 *
 * Each entry is a search spec served by the `/v1/search` native route: one
 * `serviceKind: "websearch"` model in the provider's catalog plus a
 * `createSearchAdapter` adapter. The provider ids, base URLs, and credential
 * hints live in `metadata.ts` beside every other bundled identity;
 * this file owns only the per-provider request mapping and response
 * normalization, which is what makes a provider's wire local to one spec.
 */
import type { SearchParams, SearchProviderSpec, SearchRequestInit } from "./search-provider";
import { asRecord, stringField } from "./search-provider";

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

/** Exa public MCP (`tools/call web_search_exa`). No API key. */
function exaRequest(params: SearchParams, _token: string): SearchRequestInit {
  const { includes, excludes } = domainFilterParams(params.domainFilter);
  const query = [
    params.query,
    ...includes.map((domain) => `site:${domain}`),
    ...excludes.map((domain) => `-site:${domain}`),
  ].join(" ");
  const url = new URL("https://mcp.exa.ai/mcp");
  url.searchParams.set("tools", "web_search_exa");
  return {
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "exa-search",
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query, numResults: params.maxResults },
        },
      }),
    },
  };
}

function exaResultItems(data: unknown): readonly unknown[] {
  const record = asRecord(data);
  if (Array.isArray(record?.results)) return record.results;
  const result = asRecord(record?.result);
  const structured = asRecord(result?.structuredContent);
  if (Array.isArray(structured?.results)) return structured.results;
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const part of content) {
    const text = asRecord(part)?.text;
    if (typeof text !== "string") continue;
    try {
      const parsed = asRecord(JSON.parse(text));
      if (Array.isArray(parsed?.results)) return parsed.results;
    } catch {
      // Text content is only a fallback when the MCP server returns JSON in it.
    }
  }
  return [];
}

function exaNormalize(data: unknown): readonly { title: string; url: string; snippet: string; published_at?: string | null; score?: number | null }[] {
  const structured = exaResultItems(data).flatMap((raw) => {
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
  return structured.length > 0 ? structured : exaTextResults(data);
}

/** The public MCP returns hits as labeled text, not JSON result objects. */
function exaTextResults(data: unknown): readonly { title: string; url: string; snippet: string; published_at?: string | null; score?: number | null }[] {
  const record = asRecord(data);
  const result = asRecord(record?.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.flatMap((part) => {
    const text = asRecord(part)?.text;
    if (typeof text !== "string") return [];
    return text.split("\n\n---\n\n").flatMap((block) => {
      const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
      const url = /^URL:\s*(https?:\/\/\S+)$/m.exec(block)?.[1]?.trim() ?? "";
      if (!url) return [];
      const highlights = block.split("Highlights:")[1]?.trim() ?? "";
      return [{ title: title || url, url, snippet: highlights.slice(0, 500), published_at: null, score: null }];
    });
  });
}
function parallelRequest(params: SearchParams, token: string): SearchRequestInit {
  if (token.length === 0) {
    return {
      url: "https://search.parallel.ai/mcp",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "parallel-search",
          method: "tools/call",
          params: {
            name: "web_search",
            arguments: {
              objective: params.query,
              search_queries: [params.query],
            },
          },
        }),
      },
    };
  }
  return {
    url: "https://api.parallel.ai/v1beta/search",
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": token,
        "parallel-beta": "search-extract-2025-10-10",
      },
      body: JSON.stringify({
        objective: params.query,
        search_queries: [params.query],
        mode: "fast",
        excerpts: { max_chars_per_result: 10_000 },
      }),
    },
  };
}

function parallelNormalize(data: unknown): readonly { title: string; url: string; snippet: string; published_at?: string | null; score?: number | null }[] {
  const record = asRecord(data);
  const result = asRecord(record?.result);
  const structured = asRecord(result?.structuredContent);
  const items = Array.isArray(structured?.results)
    ? structured.results
    : Array.isArray(record?.results)
      ? record.results
      : [];
  return items.flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) return [];
    const url = stringField(item, "url");
    if (!url) return [];
    const excerpts = Array.isArray(item.excerpts)
      ? item.excerpts.filter((entry): entry is string => typeof entry === "string")
      : [];
    return [
      {
        title: stringField(item, "title") || url,
        url,
        snippet: excerpts.join("\n\n").slice(0, 500),
        published_at: typeof item.publish_date === "string" ? item.publish_date : null,
        score: null,
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
  parallel: { provider_id: "parallel", buildRequest: parallelRequest, normalize: parallelNormalize },
} satisfies Readonly<Record<string, SearchProviderSpec>>;

export type SearchProviderId = keyof typeof SEARCH_PROVIDER_SPECS;
