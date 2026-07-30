import { Elysia } from "elysia";

/**
 * Builds the allow-list CORS headers for one request origin.
 * Returns null when CORS is disabled or the origin is not allowed.
 */
export function corsHeaders(origin: string | null, allowedOrigins: readonly string[]): Record<string, string> | null {
  if (allowedOrigins.length === 0 || !origin) return null;
  if (!allowedOrigins.includes("*") && !allowedOrigins.includes(origin)) return null;

  return {
    "access-control-allow-origin": allowedOrigins.includes("*") ? "*" : origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, x-api-key, content-type",
    vary: "Origin",
  };
}

/**
 * Applies allow-list CORS only to public `/v1/*` routes and short-circuits
 * allowed preflight requests. Console routes remain same-origin-only.
 */
export function createCorsMiddleware(allowedOrigins: readonly string[]) {
  return new Elysia().onRequest(({ request, set }) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) return;

    const headers = corsHeaders(request.headers.get("origin"), allowedOrigins);
    if (!headers) return;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    set.headers = { ...set.headers, ...headers };
  });
}
