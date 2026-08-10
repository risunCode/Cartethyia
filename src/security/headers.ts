const HSTS_HEADER = "max-age=63072000; includeSubDomains";
const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";

export interface SecurityHeaderOptions {
  readonly request?: Request;
  readonly html?: boolean;
  readonly noStore?: boolean;
  readonly https?: boolean;
}

function requestUsesHttps(request: Request | undefined): boolean {
  if (request === undefined) return false;
  return request.url.startsWith("https://");
}

/** Applies response headers shared by API, console, error, and static paths. */
export function applySecurityHeaders(headers: Headers, options: SecurityHeaderOptions = {}): void {
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("x-robots-tag", "noindex, nofollow");
  if (options.noStore === true) headers.set("cache-control", "no-store");
  if (options.html === true) {
    headers.set("x-frame-options", "DENY");
    headers.set("content-security-policy", CONSOLE_CSP);
  }
  if (options.https === true || requestUsesHttps(options.request)) headers.set("strict-transport-security", HSTS_HEADER);
}

/** Re-wraps a response while preserving its body and applying the common policy. */
export function secureResponse(response: Response, options: SecurityHeaderOptions = {}): Response {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers, options);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
