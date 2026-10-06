/**
 * Request-path extraction without allocating a `URL`.
 *
 * Called on every `/v1/*` request across several middleware hooks and on the
 * dashboard static handlers. Constructing a `URL` cost roughly a microsecond
 * each on Bun, so the path is sliced straight out of the raw URL string.
 *
 * Lives in `src/lib/` because it is a generic URL utility consumed by both
 * `transport/` (every ingress guard) and `console/` (CSRF and mutation
 * limiter guards). Keeping it in `transport/` forced console code to import
 * across the layer boundary for a pure string helper.
 */
export function fastPathname(url: string): string {
  // Skip scheme.
  const schemeEnd = url.indexOf("://");
  const from = schemeEnd < 0 ? 0 : schemeEnd + 3;
  const pathStart = url.indexOf("/", from);
  if (pathStart < 0) return "/";
  const queryStart = url.indexOf("?", pathStart);
  const hashStart = url.indexOf("#", pathStart);
  let end = url.length;
  if (queryStart >= 0) end = queryStart;
  if (hashStart >= 0 && hashStart < end) end = hashStart;
  return url.slice(pathStart, end);
}
