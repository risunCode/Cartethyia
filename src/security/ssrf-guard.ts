/**
 * SSRF guard — blocks server-side fetches to private, loopback, link-local,
 * and cloud-metadata targets. Applied to every user-supplied URL the server
 * dispatches to (proxy pool entries, relay targets, admin-configured OAuth
 * token URLs), and re-validated per redirect hop.
 *
 * Modernization of the legacy HTTP boundary onto the current structure:
 * IP literal classification reuses the application IPv4/IPv6 matcher
 * (`isUnsafeIp` — private, loopback, link-local, CGNAT, NAT64, multicast,
 * reserved, IPv4-mapped) from src/application/protocols.ts instead of a second
 * private copy.
 *
 * DNS rebinding: the host is resolved once immediately before dispatch and
 * every resolved address is range-checked, so a domain that changes between
 * configuration and request time cannot point at private space.
 */

import { isIpLiteral, isPrivateUseName, isUnsafeIp, normalizeHostname } from "../application/protocols";
import { fetchWithRedirectPolicy, type RedirectFollowOptions, type RedirectHopValidator } from "./redirect-policy";

/** Hostnames that are always blocked regardless of DNS resolution. */
const BLOCKED_HOSTNAMES: Record<string, true> = { localhost: true, "0.0.0.0": true };

/** Cloud-metadata and synonym hostnames that must never be reachable. */
const BLOCKED_METADATA_HOSTNAMES: Record<string, true> = { "metadata.google.internal": true, "instance-data": true };

/** Protocols accepted by the generic guard; proxy pools may be socks5. */
const DEFAULT_ALLOWED_PROTOCOLS: Record<string, true> = { "http:": true, "https:": true, "socks5:": true };

/** Bounds on input before parsing. */
export const MAX_SSRF_URL_LENGTH = 4_096;

export interface SsrfUrlOptions {
  readonly label?: string;
  readonly allowedProtocols?: Readonly<Record<string, true>>;
}

/** A single address produced by a resolver. */
export interface ResolvedAddress {
  readonly address: string;
}

export class SsrfGuardError extends Error {
  readonly reason: "invalid_url" | "unsupported_protocol" | "blocked_host" | "blocked_ip";

  constructor(reason: "invalid_url" | "unsupported_protocol" | "blocked_host" | "blocked_ip", message: string) {
    super(message);
    this.name = "SsrfGuardError";
    this.reason = reason;
  }
}

/**
 * Checks a resolved IP address string against the blocked ranges. The domain
 * matcher treats unparseable input as unsafe, so only real IP literals are
 * run through it.
 */
export function isBlockedIp(address: string): boolean {
  if (address === "::1") return true;
  return isIpLiteral(address) && isUnsafeIp(address);
}

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES[hostname] === true || BLOCKED_METADATA_HOSTNAMES[hostname] === true) return true;
  return isPrivateUseName(hostname);
}

/**
 * Validates that a URL string points at a public, routable address without
 * doing network I/O. Throws a typed SsrfGuardError with a clean message;
 * returns the parsed URL for reuse.
 */
export function assertPublicUrl(raw: string, options: SsrfUrlOptions = {}): URL {
  const label = options.label ?? "URL";
  if (raw.length === 0) throw new SsrfGuardError("invalid_url", `Invalid ${label}: no URL provided`);
  if (raw.length > MAX_SSRF_URL_LENGTH) throw new SsrfGuardError("invalid_url", `Invalid ${label}: URL exceeds ${MAX_SSRF_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfGuardError("invalid_url", `Invalid ${label}: malformed URL`);
  }
  const allowed = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
  if (allowed[url.protocol] !== true) {
    throw new SsrfGuardError("unsupported_protocol", `Invalid ${label}: protocol "${url.protocol}" not allowed`);
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) throw new SsrfGuardError("invalid_url", `Invalid ${label}: no usable host`);
  if (isBlockedHostname(hostname)) {
    throw new SsrfGuardError("blocked_host", `Invalid ${label}: host "${url.hostname}" is blocked (private/loopback/internal)`);
  }
  if (isIpLiteral(hostname) && isUnsafeIp(hostname)) {
    throw new SsrfGuardError("blocked_ip", `Blocked private IP address: "${url.hostname}"`);
  }
  return url;
}

/**
 * Validates a URL immediately before dispatch, checking every DNS-resolved
 * target to prevent rebinding after configuration-time validation. The
 * resolver is injectable for tests; by default it is Bun's DNS lookup.
 */
export async function assertPublicUrlAtDispatch(
  raw: string,
  options: SsrfUrlOptions & { readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]> } = {},
): Promise<URL> {
  const url = assertPublicUrl(raw, options);
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) throw new SsrfGuardError("invalid_url", "Invalid URL: no usable host");
  if (isIpLiteral(hostname)) return url;

  const lookup = options.lookup ?? ((host) => Bun.dns.lookup(host, { family: 0 }));
  const records = await lookup(hostname);
  if (records.length === 0) throw new SsrfGuardError("invalid_url", `Invalid ${options.label ?? "URL"}: hostname did not resolve`);
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new SsrfGuardError("blocked_ip", `Blocked private IP address "${url.hostname}": "${record.address}"`);
    }
  }
  return url;
}

/**
 * Validates a URL and returns a clean, static error message instead of
 * throwing. Returns null when the URL passes.
 */
export function validatePublicUrl(raw: string, label = "URL"): string | null {
  try {
    assertPublicUrl(raw, { label });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Fetches a user-supplied URL only after dispatch-time validation, following
 * redirects manually so every hop receives the same local + DNS check.
 * Bounded to the shared redirect policy limit.
 */
export function fetchWithSsrfGuard(
  url: string,
  init: RequestInit,
  options: RedirectFollowOptions = {},
): Promise<Response> {
  const validator: RedirectHopValidator = (target) => {
    // Must return a promise: fetchWithRedirectPolicy awaits this validator, so
    // a non-returned async rejection would become an unhandled rejection and
    // the redirect loop would continue to the cap instead of aborting.
    // .then(() => {}) narrows Promise<URL> to Promise<void> for the validator type.
    return assertPublicUrlAtDispatch(target, { label: "redirect target" }).then(() => {});
  };
  return fetchWithRedirectPolicy(url, init, { fetcher: options.fetcher, maxRedirects: options.maxRedirects, validator });
}