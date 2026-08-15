const QUERY_JSON = "application/json";

/**
 * Keeps ordinary GET callers compatible while the application routes safe
 * reads through RFC 10008 QUERY. Static assets, share pages, health checks,
 * and SSE streams stay GET because browsers and platform probes use those
 * transports directly.
 */
export function translateLegacyGet(request: Request): Request {
  if (request.method !== "GET") return request;

  const pathname = new URL(request.url).pathname;
  const isModelCatalog = pathname === "/v1/models";
  const isConsoleApi = (pathname === "/console/api" || pathname.startsWith("/console/api/")) && !pathname.endsWith("/stream");
  if (!isModelCatalog && !isConsoleApi) return request;

  const headers = new Headers(request.headers);
  headers.set("content-type", QUERY_JSON);
  headers.set("x-cartethyia-transport", "legacy-get");
  const query: Record<string, string> = {};
  new URL(request.url).searchParams.forEach((value, key) => { query[key] = value; });
  const body = JSON.stringify(query);
  return new Request(request, { method: "QUERY", headers, body, signal: request.signal });
}
