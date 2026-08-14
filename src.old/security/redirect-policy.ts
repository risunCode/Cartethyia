/**
 * Redirect hop policy for server-side fetches.
 *
 * Native `fetch` redirect handling follows the chain without letting the
 * caller re-validate intermediate hops, which is exactly where DNS-rebinding
 * and cross-origin redirects sneak in. This policy drives `redirect:
 * "manual"` and walks the chain explicitly: every hop is handed to an
 * injected validator (e.g. the SSRF guard) before it is fetched, the chain
 * is hard-bounded, and redirect targets are restricted to http(s) so a
 * hostile `Location:` cannot smuggle in another scheme.
 */

export const MAX_REDIRECTS = 5;

export type RedirectHopValidator = (url: string) => Promise<void> | void;

export interface RedirectFollowOptions {
  /** Performs the actual network step for a single validated hop. Defaults to global `fetch`. */
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  /** Hard cap on followed redirects; bounded to [0, MAX_REDIRECTS]. */
  readonly maxRedirects?: number;
  /** Called with each hop URL immediately before it is fetched. */
  readonly validator?: RedirectHopValidator;
}

export class RedirectPolicyError extends Error {
  readonly kind: "too_many_redirects" | "bad_redirect_target";

  constructor(kind: "too_many_redirects" | "bad_redirect_target", message: string) {
    super(message);
    this.name = "RedirectPolicyError";
    this.kind = kind;
  }
}

/**
 * Resolves a raw `location` header value against the current hop. Only
 * http/https targets are allowed; anything else (javascript:, data:, …) is
 * refused with a typed error instead of being fetched.
 */
export function resolveRedirectTarget(base: string, location: string): string {
  let next: URL;
  try {
    next = new URL(location, base);
  } catch {
    throw new RedirectPolicyError("bad_redirect_target", "Redirect target is not a valid URL");
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new RedirectPolicyError("bad_redirect_target", `Redirect target uses unsupported protocol "${next.protocol}"`);
  }
  return next.toString();
}

/**
 * Follows redirects manually with `redirect: "manual"`, validating every hop
 * and refusing to grow the chain past the bound. Returns the final
 * non-redirect response (or the first response without a `location` header).
 */
export async function fetchWithRedirectPolicy(target: string, init: RequestInit, options: RedirectFollowOptions = {}): Promise<Response> {
  const { fetcher = fetch, validator } = options;
  const requested = options.maxRedirects ?? MAX_REDIRECTS;
  const maxRedirects = Number.isFinite(requested) ? Math.max(0, Math.min(MAX_REDIRECTS, Math.floor(requested))) : MAX_REDIRECTS;

  let current = target;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (validator !== undefined) await validator(current);
    const response = await fetcher(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    current = resolveRedirectTarget(current, location);
  }
  throw new RedirectPolicyError("too_many_redirects", "Too many redirects while following server-side fetch");
}