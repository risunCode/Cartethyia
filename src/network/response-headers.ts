/**
 * Upstream response header sanitization shared by the HTTP/1.1 and HTTP/2
 * egress paths.
 *
 * Upstream responses must not hand gateway state or credentials to callers:
 * strip Set-Cookie/auth challenges and hop-by-hop fields; keep everything
 * content-bearing (content-type, location, etc.). Keeping this in one module
 * ensures both transports apply the identical allow/deny policy.
 */

/** Hop-by-hop and credential-bearing headers never forwarded to callers. */
export const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "cookie",
  "www-authenticate",
  "proxy-authenticate",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

/** Filters raw upstream response headers down to the forwardable set. */
export function stripResponseHeaders(
  raw: Record<string, string | string[] | undefined>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (key.startsWith(":")) continue;
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}
